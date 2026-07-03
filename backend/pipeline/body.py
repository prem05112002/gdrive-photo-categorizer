"""
Body detection + outfit re-identification — in-process (subprocess hack removed
with FAISS; see pipeline/classify.py).

- YOLO11m-seg finds person instances on the same 1920-long-side image the face
  pipeline uses, so body boxes and stored face bboxes share one coordinate
  space (the old worker detected on full-res images while face bboxes were in
  detection space — associations silently missed on large photos).
- Each masked person crop is embedded with the shared SigLIP2 encoder
  (pipeline/scene.py). Replaces HSV histograms, which broke under lighting
  changes and mostly encoded background bleed.
- Face↔body association picks the face with the highest containment fraction
  inside the body box (was: first face whose center fell in the box).
"""
import datetime
import threading
import uuid
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image

from database.models import (
    SessionLocal, Trip, Photo, FaceObservation, PersonOutfit, UnmatchedPerson,
)
from database import crud
from utils.image import open_for_processing

CONF_THRESHOLD = 0.35
OUTFIT_SIMILARITY_THRESHOLD = 0.60   # SigLIP2 crop↔crop cosine for suggestions
MIN_FACE_CONTAINMENT = 0.60          # fraction of face bbox inside body box to associate
DET_LONG_SIDE = 1920                 # must match pipeline/face.py MAX_LONG_SIDE

_body_progress: dict[str, dict] = {}


def get_body_progress(trip_id: str) -> dict | None:
    return _body_progress.get(trip_id)


# ── YOLO (lazy singleton) ─────────────────────────────────────────────────────

_yolo = None
_yolo_lock = threading.Lock()


def _get_yolo():
    global _yolo
    if _yolo is None:
        with _yolo_lock:
            if _yolo is None:
                from ultralytics import YOLO
                _yolo = YOLO("yolo11m-seg.pt")
    return _yolo


def _device() -> str:
    return "mps" if torch.backends.mps.is_available() else "cpu"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _embed_person_crops(img_rgb: np.ndarray, boxes: np.ndarray,
                        masks: list[np.ndarray | None]) -> list[bytes | None]:
    """SigLIP2-embed each person crop with its background neutralized to gray."""
    from pipeline.scene import get_encoder
    model, preprocess, _, device = get_encoder()

    tensors: list[torch.Tensor | None] = []
    for box, mask in zip(boxes, masks):
        x1, y1, x2, y2 = (int(v) for v in box)
        crop = img_rgb[max(0, y1):y2, max(0, x1):x2].copy()
        if crop.size == 0:
            tensors.append(None)
            continue
        if mask is not None:
            m = mask[max(0, y1):y2, max(0, x1):x2]
            if m.shape[:2] == crop.shape[:2]:
                crop[m < 0.5] = 127  # embedding should see the outfit, not the scene
        tensors.append(preprocess(Image.fromarray(crop)))

    valid = [(i, t) for i, t in enumerate(tensors) if t is not None]
    out: list[bytes | None] = [None] * len(tensors)
    if valid:
        stack = torch.stack([t for _, t in valid]).to(device)
        with torch.no_grad():
            feats = model.encode_image(stack)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        feats = feats.cpu().numpy().astype(np.float32)
        for (i, _), f in zip(valid, feats):
            out[i] = f.tobytes()
    return out


def _best_face_for_box(faces: list, box) -> FaceObservation | None:
    """Enrolled face with the highest containment fraction inside the body box."""
    bx1, by1, bx2, by2 = (float(v) for v in box)
    best, best_frac = None, 0.0
    for f in faces:
        if f.person_id is None or f.is_stranger or f.bbox_x is None:
            continue
        fx1, fy1 = f.bbox_x, f.bbox_y
        fx2, fy2 = fx1 + f.bbox_w, fy1 + f.bbox_h
        ix = max(0.0, min(fx2, bx2) - max(fx1, bx1))
        iy = max(0.0, min(fy2, by2) - max(fy1, by1))
        frac = (ix * iy) / max(1.0, (fx2 - fx1) * (fy2 - fy1))
        if frac > best_frac:
            best_frac, best = frac, f
    return best if best_frac >= MIN_FACE_CONTAINMENT else None


def _cosine(a: bytes, b: bytes) -> float:
    va = np.frombuffer(a, dtype=np.float32)
    vb = np.frombuffer(b, dtype=np.float32)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    return float(np.dot(va, vb)) / denom if denom > 0 else 0.0


# ── Main pipeline ─────────────────────────────────────────────────────────────

def _run_body(trip_id: str) -> None:
    session = SessionLocal()
    try:
        _body_progress[trip_id] = {"status": "running", "step": "loading_model"}
        session.query(Trip).filter(Trip.id == trip_id).update({"status": "body_detecting"})
        session.commit()

        photos = (
            session.query(Photo)
            .filter(
                Photo.trip_id == trip_id,
                Photo.is_raw == False,
                Photo.is_video == False,
                Photo.is_duplicate == False,
                Photo.local_path.isnot(None),
            )
            .all()
        )
        valid = [p for p in photos if p.local_path and Path(p.local_path).exists()]

        # Idempotent re-run: clear previous pending detections for this trip
        session.query(UnmatchedPerson).filter(
            UnmatchedPerson.trip_id == trip_id,
            UnmatchedPerson.status == "pending_review",
        ).delete(synchronize_session=False)
        session.commit()

        model = _get_yolo()
        device = _device()

        bodies_found = 0
        matched = 0
        unmatched_ids: list[str] = []
        total = len(valid)

        for i, photo in enumerate(valid):
            _body_progress[trip_id] = {
                "status": "running", "step": "detecting",
                "processed": i + 1, "total": total or 1,
            }
            try:
                # PIL loader: HEIC works (cv2.imread returns None for HEIC),
                # and 1920-resize puts boxes in face-bbox coordinate space.
                img = open_for_processing(Path(photo.local_path), DET_LONG_SIDE)
                rgb = np.array(img)
                bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)  # ultralytics expects BGR numpy

                results = model(bgr, conf=CONF_THRESHOLD, classes=[0],
                                device=device, verbose=False)[0]
                if results.boxes is None or len(results.boxes) == 0:
                    continue

                h, w = rgb.shape[:2]
                boxes = results.boxes.xyxy.cpu().numpy()
                masks: list[np.ndarray | None] = [None] * len(boxes)
                if results.masks is not None:
                    mdata = results.masks.data.cpu().numpy()
                    for k in range(min(len(boxes), len(mdata))):
                        masks[k] = cv2.resize(mdata[k], (w, h), interpolation=cv2.INTER_NEAREST)

                embeds = _embed_person_crops(rgb, boxes, masks)

                face_obs = (
                    session.query(FaceObservation)
                    .filter(FaceObservation.photo_id == photo.id)
                    .all()
                )

                for box, emb in zip(boxes, embeds):
                    bodies_found += 1
                    if emb is None:
                        continue

                    face = _best_face_for_box(face_obs, box)
                    if face is not None:
                        photo_date = (
                            photo.exif_timestamp.date().isoformat()
                            if photo.exif_timestamp
                            else datetime.date.today().isoformat()
                        )
                        existing = (
                            session.query(PersonOutfit)
                            .filter(
                                PersonOutfit.person_id == face.person_id,
                                PersonOutfit.trip_id == trip_id,
                                PersonOutfit.date == photo_date,
                            )
                            .first()
                        )
                        if existing:
                            old = np.frombuffer(existing.outfit_embedding, dtype=np.float32)
                            new = np.frombuffer(emb, dtype=np.float32)
                            n = existing.photo_count
                            avg = (old * n + new) / (n + 1)
                            avg = avg / max(float(np.linalg.norm(avg)), 1e-8)
                            existing.outfit_embedding = avg.astype(np.float32).tobytes()
                            existing.photo_count = n + 1
                            existing.updated_at = datetime.datetime.utcnow()
                        else:
                            session.add(PersonOutfit(
                                id=str(uuid.uuid4()),
                                person_id=face.person_id,
                                trip_id=trip_id,
                                date=photo_date,
                                outfit_embedding=emb,
                                photo_count=1,
                                updated_at=datetime.datetime.utcnow(),
                            ))
                        matched += 1
                    else:
                        bx1, by1, bx2, by2 = (float(v) for v in box)
                        uid = str(uuid.uuid4())
                        session.add(UnmatchedPerson(
                            id=uid,
                            photo_id=photo.id,
                            trip_id=trip_id,
                            bbox_x=int(bx1), bbox_y=int(by1),
                            bbox_w=int(bx2 - bx1), bbox_h=int(by2 - by1),
                            outfit_embedding=emb,
                            status="pending_review",
                        ))
                        unmatched_ids.append(uid)

                session.commit()

            except Exception as e:
                print(f"[body] warning photo {photo.id}: {e}")

        # Suggest identities for unmatched bodies via outfit similarity
        if unmatched_ids:
            outfits = session.query(PersonOutfit).filter(PersonOutfit.trip_id == trip_id).all()
            if outfits:
                unmatched_rows = (
                    session.query(UnmatchedPerson)
                    .filter(UnmatchedPerson.id.in_(unmatched_ids))
                    .all()
                )
                for um in unmatched_rows:
                    if not um.outfit_embedding:
                        continue
                    best_pid, best_sim = None, 0.0
                    for o in outfits:
                        sim = _cosine(um.outfit_embedding, o.outfit_embedding)
                        if sim > best_sim:
                            best_sim, best_pid = sim, o.person_id
                    if best_pid and best_sim >= OUTFIT_SIMILARITY_THRESHOLD:
                        um.suggested_person_id = best_pid
                        um.suggestion_confidence = float(best_sim)
                session.commit()

        session.expire_all()
        session.query(Trip).filter(Trip.id == trip_id).update({
            "status": "body_detected",
            "last_good_status": "body_detected",
        })
        session.commit()
        _body_progress[trip_id] = {
            "status": "done",
            "bodies_found": bodies_found,
            "matched": matched,
            "unmatched": len(unmatched_ids),
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        _body_progress[trip_id] = {"status": "error", "error": str(e)}
        try:
            err_s = SessionLocal()
            crud.fail_trip(err_s, trip_id, str(e))
            err_s.close()
        except Exception:
            pass
    finally:
        session.close()


def start_body_thread(trip_id: str) -> None:
    threading.Thread(target=_run_body, args=(trip_id,), daemon=True).start()
