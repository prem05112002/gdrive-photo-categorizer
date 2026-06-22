"""
Subprocess worker for body detection and outfit analysis.
Must be run as a standalone process — never imported into the main uvicorn process.
Reason: YOLOv8 uses PyTorch which shares libomp with FAISS → SIGSEGV on macOS ARM64.
"""
import json
import sys
import uuid
import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import cv2
import numpy as np
from ultralytics import YOLO

from database.models import SessionLocal, Photo, FaceObservation, PersonOutfit, UnmatchedPerson

CONF_THRESHOLD = 0.3
OUTFIT_SIMILARITY_THRESHOLD = 0.65


def _face_center_in_box(fx, fy, fw, fh, bx1, by1, bx2, by2) -> bool:
    cx, cy = fx + fw / 2, fy + fh / 2
    return bx1 <= cx <= bx2 and by1 <= cy <= by2


def _compute_hsv_histogram(img_rgb: np.ndarray, mask_hw: np.ndarray) -> bytes:
    hsv = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2HSV)
    mask_u8 = (mask_hw > 0.5).astype(np.uint8)
    if mask_u8.sum() == 0:
        return np.zeros(32 * 32 * 32, dtype=np.float32).tobytes()
    hist = cv2.calcHist(
        [hsv], [0, 1, 2], mask_u8,
        [32, 32, 32], [0, 180, 0, 256, 0, 256],
    )
    cv2.normalize(hist, hist, norm_type=cv2.NORM_L2)
    return hist.flatten().astype(np.float32).tobytes()


def _hist_cosine(h1_bytes: bytes, h2_bytes: bytes) -> float:
    h1 = np.frombuffer(h1_bytes, dtype=np.float32)
    h2 = np.frombuffer(h2_bytes, dtype=np.float32)
    denom = float(np.linalg.norm(h1) * np.linalg.norm(h2))
    return float(np.dot(h1, h2)) / denom if denom > 0 else 0.0


def main(trip_id: str) -> None:
    session = SessionLocal()
    try:
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

        if not valid:
            print(json.dumps({"bodies_found": 0, "matched": 0, "unmatched": 0}), flush=True)
            return

        print(json.dumps({"status": "loading_model"}), flush=True)
        # force CPU — MPS segfaults on Python 3.14 / macOS ARM64
        model = YOLO("yolov8x-seg.pt")

        bodies_found = 0
        matched = 0
        unmatched_ids: list[str] = []

        for i, photo in enumerate(valid):
            print(json.dumps({"progress": i, "total": len(valid)}), flush=True)
            try:
                img_bgr = cv2.imread(photo.local_path)
                if img_bgr is None:
                    continue
                h_orig, w_orig = img_bgr.shape[:2]
                img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

                results = model(
                    img_rgb,
                    conf=CONF_THRESHOLD,
                    classes=[0],        # class 0 = person
                    device="cpu",
                    verbose=False,
                )[0]

                if results.boxes is None or len(results.boxes) == 0:
                    continue

                face_obs = (
                    session.query(FaceObservation)
                    .filter(FaceObservation.photo_id == photo.id)
                    .all()
                )

                boxes_xyxy = results.boxes.xyxy.cpu().numpy()
                masks_data = (
                    results.masks.data.cpu().numpy()
                    if results.masks is not None
                    else None
                )

                for det_idx, box in enumerate(boxes_xyxy):
                    bx1, by1, bx2, by2 = float(box[0]), float(box[1]), float(box[2]), float(box[3])
                    bodies_found += 1

                    if masks_data is not None and det_idx < len(masks_data):
                        mask_small = masks_data[det_idx]
                        mask_hw = cv2.resize(mask_small, (w_orig, h_orig), interpolation=cv2.INTER_NEAREST)
                    else:
                        mask_hw = np.zeros((h_orig, w_orig), dtype=np.float32)
                        mask_hw[int(by1):int(by2), int(bx1):int(bx2)] = 1.0

                    hist_bytes = _compute_hsv_histogram(img_rgb, mask_hw)

                    # Match to an enrolled face whose center falls inside this person box
                    assigned_face = None
                    for face in face_obs:
                        if face.person_id is None or face.is_stranger or face.bbox_x is None:
                            continue
                        if _face_center_in_box(face.bbox_x, face.bbox_y, face.bbox_w, face.bbox_h,
                                                bx1, by1, bx2, by2):
                            assigned_face = face
                            break

                    if assigned_face:
                        photo_date = (
                            photo.exif_timestamp.date().isoformat()
                            if photo.exif_timestamp
                            else datetime.date.today().isoformat()
                        )
                        existing = (
                            session.query(PersonOutfit)
                            .filter(
                                PersonOutfit.person_id == assigned_face.person_id,
                                PersonOutfit.trip_id == trip_id,
                                PersonOutfit.date == photo_date,
                            )
                            .first()
                        )
                        if existing:
                            old_h = np.frombuffer(existing.hsv_histogram, dtype=np.float32)
                            new_h = np.frombuffer(hist_bytes, dtype=np.float32)
                            n = existing.photo_count
                            avg_h = ((old_h * n + new_h) / (n + 1)).astype(np.float32)
                            existing.hsv_histogram = avg_h.tobytes()
                            existing.photo_count = n + 1
                            existing.updated_at = datetime.datetime.utcnow()
                        else:
                            session.add(PersonOutfit(
                                id=str(uuid.uuid4()),
                                person_id=assigned_face.person_id,
                                trip_id=trip_id,
                                date=photo_date,
                                hsv_histogram=hist_bytes,
                                photo_count=1,
                                updated_at=datetime.datetime.utcnow(),
                            ))
                        matched += 1
                    else:
                        uid = str(uuid.uuid4())
                        session.add(UnmatchedPerson(
                            id=uid,
                            photo_id=photo.id,
                            trip_id=trip_id,
                            bbox_x=int(bx1), bbox_y=int(by1),
                            bbox_w=int(bx2 - bx1), bbox_h=int(by2 - by1),
                            hsv_histogram=hist_bytes,
                            status="pending_review",
                        ))
                        unmatched_ids.append(uid)

                session.commit()

            except Exception as e:
                print(json.dumps({"warning": f"photo {photo.id}: {str(e)}"}), flush=True)

        # Cross-correlate unmatched persons against enrolled outfit histograms
        if unmatched_ids:
            outfits = session.query(PersonOutfit).filter(PersonOutfit.trip_id == trip_id).all()
            if outfits:
                unmatched_rows = (
                    session.query(UnmatchedPerson)
                    .filter(UnmatchedPerson.id.in_(unmatched_ids))
                    .all()
                )
                for um in unmatched_rows:
                    if not um.hsv_histogram:
                        continue
                    best_pid, best_sim = None, 0.0
                    for o in outfits:
                        sim = _hist_cosine(um.hsv_histogram, o.hsv_histogram)
                        if sim > best_sim:
                            best_sim, best_pid = sim, o.person_id
                    if best_pid and best_sim >= OUTFIT_SIMILARITY_THRESHOLD:
                        um.suggested_person_id = best_pid
                        um.suggestion_confidence = float(best_sim)
                session.commit()

        print(json.dumps({
            "bodies_found": bodies_found,
            "matched": matched,
            "unmatched": len(unmatched_ids),
        }), flush=True)

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(json.dumps({"error": str(e)}), file=sys.stderr, flush=True)
        sys.exit(1)
    finally:
        session.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: body_detect_worker.py <trip_id>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
