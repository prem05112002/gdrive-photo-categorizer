import asyncio
import base64
import io
import json
import uuid
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from PIL import Image, ImageOps
from pydantic import BaseModel
from sqlalchemy.orm import Session, aliased
from sse_starlette.sse import EventSourceResponse

from database.models import (
    FaceObservation,
    Person,
    PersonOutfit,
    Photo,
    PotentialMisclassification,
    UnmatchedPerson,
    UserCorrection,
    get_session,
)
from database import crud
from pipeline.body import start_body_thread, get_body_progress

router = APIRouter()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _hist_cosine(h1_bytes: bytes, h2_bytes: bytes) -> float:
    h1 = np.frombuffer(h1_bytes, dtype=np.float32)
    h2 = np.frombuffer(h2_bytes, dtype=np.float32)
    denom = float(np.linalg.norm(h1) * np.linalg.norm(h2))
    return float(np.dot(h1, h2)) / denom if denom > 0 else 0.0


def _compute_body_hist(local_path: str, fx: int, fy: int, fw: int, fh: int) -> bytes | None:
    """Compute HSV histogram of the approximate body region below a face bbox."""
    img_bgr = cv2.imread(local_path)
    if img_bgr is None:
        return None
    h_img, w_img = img_bgr.shape[:2]
    fx, fy, fw, fh = int(fx), int(fy), int(fw), int(fh)
    bx = max(0, fx - fw // 2)
    by = min(fy, h_img - 1)
    bw = min(w_img - bx, fw * 2)
    bh = min(h_img - by, fh * 4)
    if bw <= 0 or bh <= 0:
        return None
    region = img_bgr[by:by + bh, bx:bx + bw]
    if region.size == 0:
        return None
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [32, 32, 32], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist, norm_type=cv2.NORM_L2)
    return hist.flatten().astype(np.float32).tobytes()


def _make_body_crop(local_path: str, bx: int, by: int, bw: int, bh: int, max_w: int = 300) -> bytes:
    """Crop body bbox from photo with padding, return JPEG bytes."""
    img = Image.open(local_path)
    img = ImageOps.exif_transpose(img)
    pad = 12
    x1 = max(0, bx - pad)
    y1 = max(0, by - pad)
    x2 = min(img.width, bx + bw + pad)
    y2 = min(img.height, by + bh + pad)
    crop = img.crop((x1, y1, x2, y2))
    if crop.width > max_w:
        ratio = max_w / crop.width
        crop = crop.resize((max_w, int(crop.height * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    crop.convert("RGB").save(buf, format="JPEG", quality=75)
    return buf.getvalue()


# ── Pydantic bodies ─────────────────────────────────────────────────────────────

class ConfirmOutfitBody(BaseModel):
    person_id: str | None = None


class ReassignBody(BaseModel):
    new_person_id: str | None = None


# ── Existing endpoints ──────────────────────────────────────────────────────────

@router.post("/{trip_id}/run", status_code=202)
def start_body_detection(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")
    if trip.status not in ("uploaded", "body_detected", "failed"):
        raise HTTPException(409, f"Body detection requires status 'uploaded', current: '{trip.status}'")
    start_body_thread(trip_id)
    return {"status": "started", "trip_id": trip_id}


@router.get("/{trip_id}/progress")
async def stream_body_progress(trip_id: str):
    async def gen():
        while True:
            p = get_body_progress(trip_id)
            yield {"data": json.dumps(p or {"status": "waiting"})}
            if p and p.get("status") in ("done", "error"):
                break
            await asyncio.sleep(0.5)
    return EventSourceResponse(gen())


# ── Outfit Matches (unmatched_persons with suggestions) ─────────────────────────

@router.get("/{trip_id}/outfit-matches")
def get_outfit_matches(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    SuggestedPerson = aliased(Person)
    rows = (
        session.query(UnmatchedPerson, Photo, SuggestedPerson)
        .join(Photo, UnmatchedPerson.photo_id == Photo.id)
        .join(SuggestedPerson, UnmatchedPerson.suggested_person_id == SuggestedPerson.id)
        .filter(
            UnmatchedPerson.trip_id == trip_id,
            UnmatchedPerson.status == "pending_review",
            UnmatchedPerson.suggested_person_id.isnot(None),
        )
        .all()
    )

    return [
        {
            "id": um.id,
            "photo_id": photo.id,
            "photo_name": photo.drive_file_name,
            "bbox_x": um.bbox_x,
            "bbox_y": um.bbox_y,
            "bbox_w": um.bbox_w,
            "bbox_h": um.bbox_h,
            "suggested_person_id": um.suggested_person_id,
            "suggested_person_name": person.name,
            "suggestion_confidence": float(um.suggestion_confidence) if um.suggestion_confidence else None,
        }
        for um, photo, person in rows
    ]


@router.get("/{trip_id}/unmatched/{um_id}/crop")
def get_unmatched_crop(trip_id: str, um_id: str, session: Session = Depends(get_session)):
    um = (
        session.query(UnmatchedPerson)
        .filter(UnmatchedPerson.id == um_id, UnmatchedPerson.trip_id == trip_id)
        .first()
    )
    if not um:
        raise HTTPException(404, "Not found")

    photo = session.query(Photo).filter(Photo.id == um.photo_id).first()
    if not photo or not photo.local_path or not Path(photo.local_path).exists():
        raise HTTPException(404, "Photo not cached — re-run body detection")

    crop_bytes = _make_body_crop(photo.local_path, um.bbox_x, um.bbox_y, um.bbox_w, um.bbox_h)
    return Response(content=crop_bytes, media_type="image/jpeg")


@router.post("/{trip_id}/outfit-matches/{um_id}/confirm")
def confirm_outfit_match(
    trip_id: str, um_id: str, body: ConfirmOutfitBody, session: Session = Depends(get_session)
):
    um = (
        session.query(UnmatchedPerson)
        .filter(UnmatchedPerson.id == um_id, UnmatchedPerson.trip_id == trip_id)
        .first()
    )
    if not um:
        raise HTTPException(404, "Not found")

    person_id = body.person_id or um.suggested_person_id
    if not person_id:
        raise HTTPException(400, "No person_id specified")

    um.suggested_person_id = person_id
    um.status = "assigned"
    session.commit()
    return {"assigned": True, "person_id": person_id}


@router.post("/{trip_id}/outfit-matches/{um_id}/dismiss")
def dismiss_outfit_match(trip_id: str, um_id: str, session: Session = Depends(get_session)):
    um = (
        session.query(UnmatchedPerson)
        .filter(UnmatchedPerson.id == um_id, UnmatchedPerson.trip_id == trip_id)
        .first()
    )
    if not um:
        raise HTTPException(404, "Not found")
    um.status = "dismissed"
    session.commit()
    return {"dismissed": True}


# ── Misclassification detection ─────────────────────────────────────────────────

MISCLASSIFY_SIMILARITY_THRESHOLD = 0.55
MISCLASSIFY_MARGIN = 0.12


@router.post("/{trip_id}/detect-misclassifications")
def detect_misclassifications(
    trip_id: str,
    similarity_threshold: float = Query(default=MISCLASSIFY_SIMILARITY_THRESHOLD, ge=0.0, le=1.0),
    margin: float = Query(default=MISCLASSIFY_MARGIN, ge=0.0, le=1.0),
    session: Session = Depends(get_session),
):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    # Clear existing pending records so this is idempotent
    session.query(PotentialMisclassification).filter(
        PotentialMisclassification.trip_id == trip_id,
        PotentialMisclassification.status == "pending_review",
    ).delete()
    session.commit()

    outfits = session.query(PersonOutfit).filter(PersonOutfit.trip_id == trip_id).all()
    if not outfits:
        return {"count": 0, "message": "No outfit data — run body detection first"}

    valid_person_ids = {row[0] for row in session.query(Person.id).all()}
    outfit_map: dict[str, bytes] = {
        o.person_id: o.hsv_histogram for o in outfits if o.person_id in valid_person_ids
    }

    face_rows = (
        session.query(FaceObservation, Photo)
        .join(Photo, FaceObservation.photo_id == Photo.id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.person_id.isnot(None),
            FaceObservation.is_stranger == False,  # noqa: E712
            FaceObservation.bbox_x.isnot(None),
        )
        .all()
    )

    created = 0
    for fo, photo in face_rows:
        if not photo.local_path or not Path(photo.local_path).exists():
            continue
        if fo.person_id not in outfit_map:
            continue

        body_hist = _compute_body_hist(photo.local_path, fo.bbox_x, fo.bbox_y, fo.bbox_w, fo.bbox_h)
        if body_hist is None:
            continue

        current_sim = _hist_cosine(body_hist, outfit_map[fo.person_id])
        best_pid, best_sim = None, current_sim
        for pid, ohist in outfit_map.items():
            if pid == fo.person_id:
                continue
            sim = _hist_cosine(body_hist, ohist)
            if sim > best_sim:
                best_sim, best_pid = sim, pid

        if (
            best_pid is not None
            and best_sim >= similarity_threshold
            and best_sim - current_sim >= margin
        ):
            session.add(PotentialMisclassification(
                id=str(uuid.uuid4()),
                face_observation_id=fo.id,
                trip_id=trip_id,
                current_person_id=fo.person_id,
                outfit_suggests_id=best_pid,
                outfit_correlation=float(best_sim),
            ))
            created += 1

    session.commit()
    return {"count": created}


@router.get("/{trip_id}/misclassifications")
def get_misclassifications(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    CurrentPerson = aliased(Person)
    SuggestsPerson = aliased(Person)

    rows = (
        session.query(PotentialMisclassification, FaceObservation, Photo, CurrentPerson, SuggestsPerson)
        .join(FaceObservation, PotentialMisclassification.face_observation_id == FaceObservation.id)
        .join(Photo, FaceObservation.photo_id == Photo.id)
        .join(CurrentPerson, PotentialMisclassification.current_person_id == CurrentPerson.id)
        .join(SuggestsPerson, PotentialMisclassification.outfit_suggests_id == SuggestsPerson.id)
        .filter(
            PotentialMisclassification.trip_id == trip_id,
            PotentialMisclassification.status == "pending_review",
        )
        .all()
    )

    return [
        {
            "id": pm.id,
            "face_observation_id": fo.id,
            "photo_id": photo.id,
            "photo_name": photo.drive_file_name,
            "face_crop": base64.b64encode(fo.face_crop).decode() if fo.face_crop else None,
            "current_person_id": pm.current_person_id,
            "current_person_name": current_p.name,
            "outfit_suggests_id": pm.outfit_suggests_id,
            "outfit_suggests_name": suggests_p.name,
            "outfit_correlation": float(pm.outfit_correlation) if pm.outfit_correlation else None,
        }
        for pm, fo, photo, current_p, suggests_p in rows
    ]


@router.post("/{trip_id}/misclassifications/{pm_id}/keep")
def keep_classification(trip_id: str, pm_id: str, session: Session = Depends(get_session)):
    pm = (
        session.query(PotentialMisclassification)
        .filter(PotentialMisclassification.id == pm_id, PotentialMisclassification.trip_id == trip_id)
        .first()
    )
    if not pm:
        raise HTTPException(404, "Not found")
    pm.status = "confirmed"
    session.commit()
    return {"kept": True}


@router.post("/{trip_id}/misclassifications/{pm_id}/reassign")
def reassign_misclassification(
    trip_id: str, pm_id: str, body: ReassignBody, session: Session = Depends(get_session)
):
    pm = (
        session.query(PotentialMisclassification)
        .filter(PotentialMisclassification.id == pm_id, PotentialMisclassification.trip_id == trip_id)
        .first()
    )
    if not pm:
        raise HTTPException(404, "Not found")

    new_person_id = body.new_person_id or pm.outfit_suggests_id
    fo = session.query(FaceObservation).filter(FaceObservation.id == pm.face_observation_id).first()
    if fo:
        old_pid = fo.person_id
        fo.person_id = new_person_id
        session.add(UserCorrection(
            id=str(uuid.uuid4()),
            trip_id=trip_id,
            face_observation_id=fo.id,
            old_person_id=old_pid,
            new_person_id=new_person_id,
            correction_type="misclassification_reassign",
        ))
    pm.status = "dismissed"
    session.commit()
    return {"reassigned": True, "new_person_id": new_person_id}
