import io
import threading
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

from database.models import SessionLocal, Photo, FaceObservation
from database import crud  # noqa: F401 — used in error handler

GROUP_PHOTO_MIN_FACES = 5   # photos with ≥ this many faces are group photo candidates
MAX_LONG_SIDE = 1920        # resize before detection to bound memory usage
FACE_PAD = 0.25             # fractional padding around each face crop

# ── Progress (mirrors ingest.py pattern) ──────────────────────────────────────

_progress: dict[str, dict] = {}


def get_face_progress(trip_id: str) -> dict:
    return _progress.get(trip_id, {})


def _update(trip_id: str, **kwargs) -> None:
    if trip_id not in _progress:
        _progress[trip_id] = {}
    _progress[trip_id].update(kwargs)


# ── Model (lazy singleton, thread-safe) ───────────────────────────────────────

_model = None
_model_lock = threading.Lock()


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = _init_model()
    return _model


def _init_model():
    import onnxruntime as ort
    from insightface.app import FaceAnalysis

    available = ort.get_available_providers()
    if "CoreMLExecutionProvider" in available:
        providers = [
            ("CoreMLExecutionProvider", {"MLComputeUnits": "ALL"}),
            "CPUExecutionProvider",
        ]
        print("[face] Using CoreML execution provider (M2 ANE/GPU)")
    else:
        providers = ["CPUExecutionProvider"]
        print("[face] CoreML not available — using CPU")

    app = FaceAnalysis(name="buffalo_l", providers=providers)
    # det_size=(640,640) is the standard input size for buffalo_l detector
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


# ── Image helpers ─────────────────────────────────────────────────────────────

def _load_image(path: Path) -> Optional[np.ndarray]:
    """Open any supported image as an RGB numpy array, resized to MAX_LONG_SIDE."""
    try:
        img = Image.open(path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > MAX_LONG_SIDE:
            scale = MAX_LONG_SIDE / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        return np.array(img)
    except Exception:
        return None


def _face_crop_bytes(img: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> bytes:
    """Crop a face region with padding and return it as JPEG bytes (max 256px)."""
    h, w = img.shape[:2]
    pw = int((x2 - x1) * FACE_PAD)
    ph = int((y2 - y1) * FACE_PAD)
    cx1 = max(0, x1 - pw)
    cy1 = max(0, y1 - ph)
    cx2 = min(w, x2 + pw)
    cy2 = min(h, y2 + ph)
    crop = Image.fromarray(img[cy1:cy2, cx1:cx2])
    crop.thumbnail((256, 256))
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_face_pipeline(trip_id: str) -> None:
    """
    Detect faces in every processable photo for a trip.
    For each face: stores a FaceObservation with raw 512-dim embedding + face crop.
    Updates Photo.face_count and Photo.is_group_photo.
    Runs synchronously — call via start_face_pipeline_thread() for background use.
    """
    session = SessionLocal()

    try:
        photos = [
            p for p in crud.get_photos_by_trip(session, trip_id)
            if not p.is_raw and not p.is_video and not p.is_duplicate and p.local_path
        ]
        total = len(photos)

        crud.update_trip_status(session, trip_id, "extracting_faces")
        _update(trip_id,
                status="loading_model",
                total=total,
                processed=0,
                faces_found=0,
                group_photos=0)

        model = get_model()  # downloads buffalo_l on first run (~235 MB)

        _update(trip_id, status="processing")

        faces_found = 0
        group_photo_count = 0

        for idx, photo in enumerate(photos):
            path = Path(photo.local_path)
            if not path.exists():
                _update(trip_id, processed=idx + 1)
                continue

            img = _load_image(path)
            if img is None:
                _update(trip_id, processed=idx + 1)
                continue

            faces = model.get(img)
            face_count = len(faces)
            is_group = face_count >= GROUP_PHOTO_MIN_FACES

            # Update photo stats
            session.query(Photo).filter(Photo.id == photo.id).update({
                "face_count": face_count,
                "is_group_photo": is_group,
            })

            for face in faces:
                x1, y1, x2, y2 = face.bbox.astype(int)

                obs = FaceObservation(
                    id=str(uuid.uuid4()),
                    photo_id=photo.id,
                    raw_embedding=face.normed_embedding.astype(np.float32).tobytes(),  # L2-normalized, norm≈1.0
                    bbox_x=int(x1),
                    bbox_y=int(y1),
                    bbox_w=int(x2 - x1),
                    bbox_h=int(y2 - y1),
                    confidence=float(face.det_score),
                    face_crop=_face_crop_bytes(img, x1, y1, x2, y2),
                )
                session.add(obs)

            session.commit()

            faces_found += face_count
            if is_group:
                group_photo_count += 1

            _update(trip_id,
                    processed=idx + 1,
                    faces_found=faces_found,
                    group_photos=group_photo_count)

        crud.update_trip_status(session, trip_id, "faces_extracted")
        _update(trip_id,
                status="done",
                total=total,
                processed=total,
                faces_found=faces_found,
                group_photos=group_photo_count)

    except Exception as e:
        crud.fail_trip(session, trip_id, str(e))
        _update(trip_id, status="error", error=str(e))
        raise
    finally:
        session.close()


def start_face_pipeline_thread(trip_id: str) -> None:
    thread = threading.Thread(target=run_face_pipeline, args=(trip_id,), daemon=True)
    thread.start()
