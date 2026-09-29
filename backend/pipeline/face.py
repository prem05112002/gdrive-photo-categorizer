import io
import itertools
import math
import threading
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image, ImageOps
import pillow_heif
from sqlalchemy import or_

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

# Orientation — some photos are stored sideways with no EXIF tag (Kochi: the
# Canon held in portrait), so exif_transpose can't upright them. The detector
# still finds those faces, but ArcFace barely recognises a sideways face
# (measured: best registry similarity 0.26 sideways vs 0.69 upright, and 11 of
# 13 such "strangers" were members) and the stored crop is unreadable. So the
# roll is read off the detector's eye keypoints; a face more than a quarter
# turn off gets the whole image turned upright and detected again, and that
# embedding + crop are kept. FaceObservation.rotation records the turn.
UPRIGHT_ROLL_TOLERANCE = 45.0   # degrees off vertical before a face counts as sideways
REDETECT_MIN_IOU = 0.5          # the upright detection must overlap the mapped original box

# Re-runs keep every human decision (named/dismissed rows), refresh them in
# place, and land an already-enrolled trip back at "enrolled" — its roster
# survives, classification has to run again for the new faces.
POST_ENROLLMENT_STATUSES = {"enrolled", "classified", "uploaded", "body_detecting", "body_detected"}

_CV2_ROTATE = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_CLOCKWISE}

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
    """
    Open any supported image as an RGB numpy array, resized to MAX_LONG_SIDE.

    EXIF orientation is applied first, so detection space is the photo as a
    viewer sees it. Phone JPEGs are often stored sideways with an orientation
    tag: without this the detector saw them rotated (Kochi trip, 155 such
    photos: 109 faces found vs 171 upright) and their bboxes lived in a
    different coordinate space from every consumer that honours EXIF.
    """
    try:
        img = ImageOps.exif_transpose(Image.open(path))
        if img.mode != "RGB":
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > MAX_LONG_SIDE:
            scale = MAX_LONG_SIDE / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        return np.array(img)
    except Exception:
        return None


def _face_crop_bytes(img: np.ndarray, x1: int, y1: int, x2: int, y2: int, rotation: int = 0) -> bytes:
    """Crop a face region with padding, turn it upright, return JPEG bytes (max 256px)."""
    h, w = img.shape[:2]
    pw = int((x2 - x1) * FACE_PAD)
    ph = int((y2 - y1) * FACE_PAD)
    cx1 = max(0, x1 - pw)
    cy1 = max(0, y1 - ph)
    cx2 = min(w, x2 + pw)
    cy2 = min(h, y2 + ph)
    crop = Image.fromarray(img[cy1:cy2, cx1:cx2])
    if rotation:
        crop = crop.rotate(rotation, expand=True)   # PIL turns counter-clockwise, same as `rotation`
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


# ── Orientation helpers ───────────────────────────────────────────────────────

def _face_roll(face) -> float:
    """In-plane roll from the eye line, degrees: 0 upright, +90 = top of head points right."""
    if face.kps is None or len(face.kps) < 2:
        return 0.0
    (lx, ly), (rx, ry) = face.kps[0], face.kps[1]
    return math.degrees(math.atan2(ry - ly, rx - lx))


def _upright_rotation(face) -> int:
    """Counter-clockwise quarter turn (0/90/180/270) that would make the face upright."""
    roll = _face_roll(face)
    if abs(roll) <= UPRIGHT_ROLL_TOLERANCE:
        return 0
    return int(round(roll / 90.0)) * 90 % 360


def _rotate_box(box: tuple, w: int, h: int, rotation: int) -> tuple[float, float, float, float]:
    """Map an (x1, y1, x2, y2) box of a w×h image through a counter-clockwise quarter turn."""
    x1, y1, x2, y2 = box
    if rotation == 90:      # (x, y) → (y, w - x)
        pts = [(y1, w - x2), (y2, w - x1)]
    elif rotation == 180:   # (x, y) → (w - x, h - y)
        pts = [(w - x2, h - y2), (w - x1, h - y1)]
    else:                   # 270: (x, y) → (h - y, x)
        pts = [(h - y2, x1), (h - y1, x2)]
    xs, ys = zip(*pts)
    return (min(xs), min(ys), max(xs), max(ys))


def _iou(a: tuple, b: tuple) -> float:
    iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = iw * ih
    if inter <= 0:
        return 0.0
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def _upright_face(model, img: np.ndarray, face, rotation: int, cache: dict):
    """
    Detect `face` again on the image turned upright by `rotation`. Rotated images
    and their detections are cached per photo so several sideways faces in one
    photo cost one extra detector pass. Returns (upright_face | None, rotated_img).
    """
    if rotation not in cache:
        rimg = cv2.rotate(img, _CV2_ROTATE[rotation])
        cache[rotation] = (rimg, model.get(cv2.cvtColor(rimg, cv2.COLOR_RGB2BGR)))
    rimg, dets = cache[rotation]
    h, w = img.shape[:2]
    target = _rotate_box(tuple(face.bbox), w, h, rotation)
    best, best_iou = None, 0.0
    for d in dets:
        score = _iou(target, tuple(d.bbox))
        if score > best_iou:
            best, best_iou = d, score
    if best is None or best_iou < REDETECT_MIN_IOU or abs(_face_roll(best)) > UPRIGHT_ROLL_TOLERANCE:
        return None, rimg
    return best, rimg


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
    For each face: stores a FaceObservation with raw 512-dim embedding + upright
    face crop + quality flags. Updates Photo.face_count and Photo.is_group_photo.

    Re-running is idempotent and keeps every human decision: observations that
    are named or dismissed survive and are refreshed in place when the detector
    finds the same face again (bbox IoU ≥ REDETECT_MIN_IOU); all other
    observations are re-detected from scratch. A trip that was already enrolled
    comes back as "enrolled" (its roster is intact) and needs classification
    again. Runs synchronously — call via start_face_pipeline_thread() for
    background use.
    """
    session = SessionLocal()

    try:
        trip = crud.get_trip(session, trip_id)
        prior = trip.last_good_status if trip and trip.status == "failed" else (trip.status if trip else None)
        resume_status = "enrolled" if prior in POST_ENROLLMENT_STATUSES else "faces_extracted"

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
                low_quality=0,
                sideways=0,
                uprighted=0)

        model = get_model()  # downloads buffalo_l on first run (~235 MB)

        # Snapshot plain values before any commits — ORM objects must not be
        # shared with the decode threads (see _decoded_stream docstring)
        items = [(p.id, p.local_path) for p in photos]
        photo_ids = [pid for pid, _ in items]

        # Rows carrying a human decision (named or dismissed) survive the re-run
        # and are refreshed in place below; everything else is re-detected.
        kept: dict[str, list[tuple[str, tuple[int, int, int, int]]]] = {}
        if photo_ids:
            decided = (
                session.query(FaceObservation.id, FaceObservation.photo_id,
                              FaceObservation.bbox_x, FaceObservation.bbox_y,
                              FaceObservation.bbox_w, FaceObservation.bbox_h)
                .filter(
                    FaceObservation.photo_id.in_(photo_ids),
                    or_(FaceObservation.person_id.isnot(None), FaceObservation.is_stranger == True),  # noqa: E712
                )
                .all()
            )
            for obs_id, pid, bx, by, bw, bh in decided:
                if bx is not None:
                    kept.setdefault(pid, []).append((obs_id, (bx, by, bx + bw, by + bh)))
            session.query(FaceObservation).filter(
                FaceObservation.photo_id.in_(photo_ids),
                FaceObservation.person_id.is_(None),
                or_(FaceObservation.is_stranger.is_(None), FaceObservation.is_stranger == False),  # noqa: E712
            ).delete(synchronize_session=False)
            session.commit()

        _update(trip_id, status="processing")

        faces_found = 0
        group_photo_count = 0
        low_quality_count = 0
        sideways_count = 0
        uprighted_count = 0
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

            rotated: dict[int, tuple[np.ndarray, list]] = {}   # per-photo cache of uprighted images
            unclaimed = list(kept.get(photo_id, []))

            for face in faces:
                x1, y1, x2, y2 = (int(v) for v in face.bbox)
                det_score = float(face.det_score)
                embedding = face.normed_embedding
                rotation = _upright_rotation(face)
                if rotation:
                    sideways_count += 1
                    upright, rimg = _upright_face(model, img, face, rotation, rotated)
                    if upright is not None:
                        uprighted_count += 1
                        det_score = float(upright.det_score)
                        embedding = upright.normed_embedding
                        ux1, uy1, ux2, uy2 = (int(v) for v in upright.bbox)
                        crop = _face_crop_bytes(rimg, ux1, uy1, ux2, uy2)
                    else:
                        crop = _face_crop_bytes(img, x1, y1, x2, y2, rotation)  # readable at least
                else:
                    crop = _face_crop_bytes(img, x1, y1, x2, y2)

                blur, low_q = _face_quality(img, x1, y1, x2, y2, det_score)
                if low_q:
                    low_quality_count += 1

                values = {
                    "bbox_x": x1,
                    "bbox_y": y1,
                    "bbox_w": x2 - x1,
                    "bbox_h": y2 - y1,
                    "confidence": det_score,
                    "blur_score": blur,
                    "is_low_quality": low_q,
                    "raw_embedding": embedding.astype(np.float32).tobytes(),  # L2-normalized, norm≈1.0
                    "face_crop": crop,
                    "rotation": rotation,
                }

                # The same face as a kept (named/dismissed) row? Refresh that row
                # instead of inserting a duplicate that would land in Review.
                best_i, best_iou = -1, 0.0
                for i, (_, kbox) in enumerate(unclaimed):
                    score = _iou((x1, y1, x2, y2), kbox)
                    if score > best_iou:
                        best_i, best_iou = i, score
                if best_iou >= REDETECT_MIN_IOU:
                    obs_id, _ = unclaimed.pop(best_i)
                    session.query(FaceObservation).filter(FaceObservation.id == obs_id).update(
                        values, synchronize_session=False)
                else:
                    session.add(FaceObservation(id=str(uuid.uuid4()), photo_id=photo_id, **values))

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
                    low_quality=low_quality_count,
                    sideways=sideways_count,
                    uprighted=uprighted_count)

        session.commit()

        crud.update_trip_status(session, trip_id, resume_status)
        _update(trip_id,
                status="done",
                total=total,
                processed=total,
                faces_found=faces_found,
                group_photos=group_photo_count,
                low_quality=low_quality_count,
                sideways=sideways_count,
                uprighted=uprighted_count)

    except Exception as e:
        crud.fail_trip(session, trip_id, str(e))
        _update(trip_id, status="error", error=str(e))
        raise
    finally:
        session.close()


def start_face_pipeline_thread(trip_id: str) -> None:
    thread = threading.Thread(target=run_face_pipeline, args=(trip_id,), daemon=True)
    thread.start()
