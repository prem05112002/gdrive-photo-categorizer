import io
import itertools
import threading
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image
import pillow_heif

from database.models import SessionLocal, Photo, FaceObservation
from database import crud  # noqa: F401 — used in error handler

pillow_heif.register_heif_opener()  # HEIC support — must happen before any Image.open

GROUP_PHOTO_MIN_FACES = 5   # photos with ≥ this many faces are group photo candidates
MAX_LONG_SIDE = 1920        # resize before detection to bound memory usage
FACE_PAD = 0.25             # fractional padding around each face crop

DECODE_WORKERS = 4          # decode/resize images ahead of the detector
COMMIT_BATCH = 25           # photos per DB commit

# Quality gate — faces failing any of these produce unreliable embeddings and
# would only pollute clustering. They are stored (for gallery display) but
# flagged is_low_quality and excluded from enrollment clustering.
MIN_DET_SCORE = 0.65
MIN_FACE_SIZE = 40          # px, in detection space (MAX_LONG_SIDE-resized image)
MIN_BLUR_VAR = 45.0         # Laplacian variance on the gray face crop

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

    # Only the detector + ArcFace recognizer are used. Left unrestricted,
    # InsightFace also loads and runs the 3d68/2d106 landmark and gender/age
    # models on every face for nothing (~30% CPU time, ~150 MB of weights).
    app = FaceAnalysis(
        name="buffalo_l",
        providers=providers,
        allowed_modules=["detection", "recognition"],
    )
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


def _face_quality(img: np.ndarray, x1: int, y1: int, x2: int, y2: int,
                  det_score: float) -> tuple[float, bool]:
    """Return (blur_score, is_low_quality) for a detected face."""
    h, w = img.shape[:2]
    crop = img[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
    if crop.size == 0:
        return 0.0, True
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    low = (
        det_score < MIN_DET_SCORE
        or min(x2 - x1, y2 - y1) < MIN_FACE_SIZE
        or blur < MIN_BLUR_VAR
    )
    return blur, low


def _decoded_stream(items: list[tuple[str, str]]):
    """
    Yield (photo_id, img_or_None) with decode/resize running DECODE_WORKERS
    ahead on background threads, so the detector never waits on image I/O.

    items are plain (photo_id, local_path) tuples — worker threads must never
    touch ORM objects: session.commit() expires attributes, and the resulting
    lazy reload would hit the (non-thread-safe) session from another thread.
    """
    def load(path_str: str):
        path = Path(path_str)
        return _load_image(path) if path.exists() else None

    with ThreadPoolExecutor(max_workers=DECODE_WORKERS) as pool:
        it = iter(items)
        queue = deque(
            (pid, pool.submit(load, path))
            for pid, path in itertools.islice(it, DECODE_WORKERS * 2)
        )
        while queue:
            photo_id, fut = queue.popleft()
            for pid, path in itertools.islice(it, 1):
                queue.append((pid, pool.submit(load, path)))
            yield photo_id, fut.result()


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_face_pipeline(trip_id: str) -> None:
    """
    Detect faces in every processable photo for a trip.
    For each face: stores a FaceObservation with raw 512-dim embedding + face crop
    + quality flags. Updates Photo.face_count and Photo.is_group_photo.
    Re-running is idempotent: prior unassigned observations are cleared first.
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
                group_photos=0,
                low_quality=0)

        model = get_model()  # downloads buffalo_l on first run (~235 MB)

        # Snapshot plain values before any commits — ORM objects must not be
        # shared with the decode threads (see _decoded_stream docstring)
        items = [(p.id, p.local_path) for p in photos]

        # Idempotent re-run: drop unassigned observations from any earlier run
        photo_ids = [pid for pid, _ in items]
        if photo_ids:
            session.query(FaceObservation).filter(
                FaceObservation.photo_id.in_(photo_ids),
                FaceObservation.person_id.is_(None),
            ).delete(synchronize_session=False)
            session.commit()

        _update(trip_id, status="processing")

        faces_found = 0
        group_photo_count = 0
        low_quality_count = 0
        since_commit = 0

        for idx, (photo_id, img) in enumerate(_decoded_stream(items)):
            if img is None:
                _update(trip_id, processed=idx + 1)
                continue

            # InsightFace's model zoo is written for cv2 (BGR) input and swaps
            # channels internally (swapRB=True). Feeding RGB shifts every
            # embedding (measured: cos(RGB, BGR) ≈ 0.88 for the same face).
            # Convert for the model only — crops and blur scores stay RGB.
            faces = model.get(cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
            face_count = len(faces)
            is_group = face_count >= GROUP_PHOTO_MIN_FACES

            # Update photo stats
            session.query(Photo).filter(Photo.id == photo_id).update({
                "face_count": face_count,
                "is_group_photo": is_group,
            })

            for face in faces:
                x1, y1, x2, y2 = face.bbox.astype(int)
                det_score = float(face.det_score)
                blur, low_q = _face_quality(img, x1, y1, x2, y2, det_score)
                if low_q:
                    low_quality_count += 1

                obs = FaceObservation(
                    id=str(uuid.uuid4()),
                    photo_id=photo_id,
                    raw_embedding=face.normed_embedding.astype(np.float32).tobytes(),  # L2-normalized, norm≈1.0
                    bbox_x=int(x1),
                    bbox_y=int(y1),
                    bbox_w=int(x2 - x1),
                    bbox_h=int(y2 - y1),
                    confidence=det_score,
                    blur_score=blur,
                    is_low_quality=low_q,
                    face_crop=_face_crop_bytes(img, x1, y1, x2, y2),
                )
                session.add(obs)

            since_commit += 1
            if since_commit >= COMMIT_BATCH:
                session.commit()
                since_commit = 0

            faces_found += face_count
            if is_group:
                group_photo_count += 1

            _update(trip_id,
                    processed=idx + 1,
                    faces_found=faces_found,
                    group_photos=group_photo_count,
                    low_quality=low_quality_count)

        session.commit()

        crud.update_trip_status(session, trip_id, "faces_extracted")
        _update(trip_id,
                status="done",
                total=total,
                processed=total,
                faces_found=faces_found,
                group_photos=group_photo_count,
                low_quality=low_quality_count)

    except Exception as e:
        crud.fail_trip(session, trip_id, str(e))
        _update(trip_id, status="error", error=str(e))
        raise
    finally:
        session.close()


def start_face_pipeline_thread(trip_id: str) -> None:
    thread = threading.Thread(target=run_face_pipeline, args=(trip_id,), daemon=True)
    thread.start()
