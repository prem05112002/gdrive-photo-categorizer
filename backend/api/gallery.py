import io
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database.models import get_session, Photo, FaceObservation, Person, TripPerson, Trip
from database import crud

_ALLOWED_SCENE_LABELS = {
    "beach", "mountain", "temple", "monument", "street",
    "market", "nature", "indoor", "food", "other",
}

trips_router = APIRouter()
photos_router = APIRouter()

_TEMP = Path(__file__).parent.parent / "temp"


# ── Trip gallery ───────────────────────────────────────────────────────────────

@trips_router.get("/{trip_id}/gallery")
def get_gallery(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    enrolled = (
        session.query(Person, TripPerson)
        .join(TripPerson, TripPerson.person_id == Person.id)
        .filter(TripPerson.trip_id == trip_id)
        .all()
    )

    persons_out = []
    for person, _ in enrolled:
        rows = (
            session.query(Photo, FaceObservation)
            .join(FaceObservation, FaceObservation.photo_id == Photo.id)
            .filter(
                Photo.trip_id == trip_id,
                FaceObservation.person_id == person.id,
            )
            .order_by(Photo.exif_timestamp)
            .all()
        )
        seen: set[str] = set()
        photos = []
        for photo, face_obs in rows:
            if photo.id in seen:
                continue
            seen.add(photo.id)
            photos.append({
                "id": photo.id,
                "filename": photo.drive_file_name,
                "date": photo.exif_timestamp.date().isoformat() if photo.exif_timestamp else None,
                "face_obs_id": face_obs.id,
                "bbox_x": face_obs.bbox_x,
                "bbox_y": face_obs.bbox_y,
                "bbox_w": face_obs.bbox_w,
                "bbox_h": face_obs.bbox_h,
            })
        persons_out.append({
            "id": person.id,
            "name": person.name,
            "photo_count": len(photos),
            "photos": photos,
        })

    persons_out.sort(key=lambda p: p["photo_count"], reverse=True)

    # Places: no-face photos grouped by scene label
    no_face_photos = (
        session.query(Photo)
        .filter(
            Photo.trip_id == trip_id,
            Photo.face_count == 0,
            Photo.is_raw == False,
            Photo.is_video == False,
            Photo.is_duplicate == False,
        )
        .order_by(Photo.exif_timestamp)
        .all()
    )

    places_dict: dict[str, list] = {}
    for p in no_face_photos:
        label = p.scene_label or "other"
        places_dict.setdefault(label, []).append({
            "id": p.id,
            "filename": p.drive_file_name,
            "date": p.exif_timestamp.date().isoformat() if p.exif_timestamp else None,
        })

    places_out = [{"label": label, "photos": photos} for label, photos in places_dict.items()]

    # Misc: photos with unmatched, non-stranger faces
    misc_photos = (
        session.query(Photo)
        .join(FaceObservation, FaceObservation.photo_id == Photo.id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.person_id.is_(None),
            FaceObservation.is_stranger == False,
        )
        .distinct()
        .order_by(Photo.exif_timestamp)
        .all()
    )

    misc_out = []
    for p in misc_photos:
        unmatched_faces = (
            session.query(FaceObservation)
            .filter(
                FaceObservation.photo_id == p.id,
                FaceObservation.person_id.is_(None),
                FaceObservation.is_stranger == False,
            )
            .all()
        )
        misc_out.append({
            "photo_id": p.id,
            "filename": p.drive_file_name,
            "date": p.exif_timestamp.date().isoformat() if p.exif_timestamp else None,
            "face_ids": [f.id for f in unmatched_faces],
        })

    return {"persons": persons_out, "places": places_out, "misc": misc_out}


@trips_router.get("/{trip_id}/cover")
def get_cover(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    photo = (
        session.query(Photo)
        .filter(Photo.trip_id == trip_id, Photo.is_group_photo == True)
        .order_by(Photo.face_count.desc())
        .first()
    )
    if not photo:
        photo = (
            session.query(Photo)
            .filter(Photo.trip_id == trip_id, Photo.face_count > 0)
            .order_by(Photo.face_count.desc())
            .first()
        )
    if not photo or not photo.local_path:
        raise HTTPException(404, "No cover photo available")

    path = Path(photo.local_path)
    if not path.exists():
        raise HTTPException(404, "Cover photo file not on disk")

    return FileResponse(str(path), media_type="image/jpeg")


# ── Photo serving ──────────────────────────────────────────────────────────────

@photos_router.get("/{photo_id}/image")
def get_photo_image(
    photo_id: str,
    trip_id: str = Query(...),
    session: Session = Depends(get_session),
):
    photo = session.query(Photo).filter(Photo.id == photo_id, Photo.trip_id == trip_id).first()
    if not photo:
        raise HTTPException(404, "Photo not found")

    if not photo.local_path:
        raise HTTPException(404, "No local path for photo")

    path = Path(photo.local_path)
    if not path.exists():
        raise HTTPException(404, detail={"cache_cleared": True, "message": "Photo not on disk"})

    _NO_CACHE = {"Cache-Control": "no-store"}
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return FileResponse(str(path), media_type="image/jpeg", headers=_NO_CACHE)
    if suffix == ".png":
        return FileResponse(str(path), media_type="image/png", headers=_NO_CACHE)
    # HEIC/HEIF and anything else — convert to JPEG via PIL, capped at 2048px long side
    import io
    import pillow_heif
    from PIL import Image, ImageOps
    pillow_heif.register_heif_opener()
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img).convert("RGB")
        max_side = 2048
        if max(img.width, img.height) > max_side:
            scale = max_side / max(img.width, img.height)
            img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
    return Response(content=buf.getvalue(), media_type="image/jpeg", headers=_NO_CACHE)


@photos_router.get("/{photo_id}/thumbnail")
def get_photo_thumbnail(
    photo_id: str,
    trip_id: str = Query(...),
    w: int = Query(default=480, ge=64, le=1200),
    session: Session = Depends(get_session),
):
    """Resized JPEG thumbnail for grid display. w= sets max dimension (default 480px)."""
    import pillow_heif
    from PIL import Image, ExifTags
    pillow_heif.register_heif_opener()

    photo = session.query(Photo).filter(Photo.id == photo_id, Photo.trip_id == trip_id).first()
    if not photo:
        raise HTTPException(404, "Photo not found")

    if not photo.local_path:
        raise HTTPException(404, "No local path for photo")

    path = Path(photo.local_path)
    if not path.exists():
        raise HTTPException(404, detail={"cache_cleared": True, "message": "Photo not on disk"})

    try:
        with Image.open(path) as img:
            # Respect EXIF orientation
            try:
                exif = img._getexif()
                if exif:
                    orientation_key = next(
                        k for k, v in ExifTags.TAGS.items() if v == "Orientation"
                    )
                    orientation = exif.get(orientation_key)
                    _ROT = {3: 180, 6: 270, 8: 90}
                    if orientation in _ROT:
                        img = img.rotate(_ROT[orientation], expand=True)
            except Exception:
                pass

            img.thumbnail((w, w), Image.LANCZOS)
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="JPEG", quality=75, optimize=True)
            return Response(content=buf.getvalue(), media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400"})
    except Exception as e:
        raise HTTPException(500, f"Thumbnail generation failed: {e}")


class SceneLabelPayload(BaseModel):
    trip_id: str
    scene_label: str


@photos_router.patch("/{photo_id}/scene-label")
def update_scene_label(
    photo_id: str,
    payload: SceneLabelPayload,
    session: Session = Depends(get_session),
):
    if payload.scene_label not in _ALLOWED_SCENE_LABELS:
        raise HTTPException(400, f"Invalid scene label: {payload.scene_label}")
    photo = session.query(Photo).filter(
        Photo.id == photo_id,
        Photo.trip_id == payload.trip_id,
    ).first()
    if not photo:
        raise HTTPException(404, "Photo not found")
    photo.scene_label = payload.scene_label
    session.commit()
    return {"scene_label": photo.scene_label}


@photos_router.get("/{photo_id}/face/{face_id}")
def get_face_crop(
    photo_id: str,
    face_id: str,
    session: Session = Depends(get_session),
):
    face = session.query(FaceObservation).filter(
        FaceObservation.id == face_id,
        FaceObservation.photo_id == photo_id,
    ).first()
    if not face:
        raise HTTPException(404, "Face not found")

    if not face.face_crop:
        raise HTTPException(404, "No face crop available")

    return Response(content=face.face_crop, media_type="image/jpeg")


@photos_router.get("/{photo_id}/face/{face_id}/context")
def get_face_context(
    photo_id: str,
    face_id: str,
    w: int = Query(default=720, ge=128, le=1600),
    session: Session = Depends(get_session),
):
    """
    A face in context: a crop of the original photo about three face-widths
    wide around the box, with the face outlined. The stored 256px crops are too
    tight to recognise someone from; hair, shoulders and setting make it obvious.
    """
    import pillow_heif
    from PIL import Image, ImageDraw, ImageOps
    from pipeline.face import MAX_LONG_SIDE
    pillow_heif.register_heif_opener()

    face = session.query(FaceObservation).filter(
        FaceObservation.id == face_id,
        FaceObservation.photo_id == photo_id,
    ).first()
    if not face or face.bbox_w is None or face.bbox_h is None:
        raise HTTPException(404, "Face not found")
    photo = session.query(Photo).filter(Photo.id == photo_id).first()
    if not photo or not photo.local_path:
        raise HTTPException(404, "Photo not found")
    path = Path(photo.local_path)
    if not path.exists():
        raise HTTPException(404, detail={"cache_cleared": True, "message": "Photo not on disk"})

    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        # detection space (EXIF-upright, long side ≤ MAX_LONG_SIDE) → original pixels
        scale = min(MAX_LONG_SIDE / max(img.width, img.height), 1.0)
        bx, by, bw, bh = (v / scale for v in (face.bbox_x, face.bbox_y, face.bbox_w, face.bbox_h))
        cw, ch = bw * 3.0, bh * 3.4
        cx, cy = bx + bw / 2, by + bh * 0.85   # centre a little below the face → shoulders in frame
        x1, y1 = max(0, int(cx - cw / 2)), max(0, int(cy - ch / 2))
        x2, y2 = min(img.width, int(cx + cw / 2)), min(img.height, int(cy + ch / 2))
        crop = img.crop((x1, y1, x2, y2)).convert("RGB")

        out_scale = min(w / max(crop.width, crop.height), 1.0)
        if out_scale < 1.0:
            crop = crop.resize((int(crop.width * out_scale), int(crop.height * out_scale)), Image.LANCZOS)
        fx1, fy1 = (bx - x1) * out_scale, (by - y1) * out_scale
        ImageDraw.Draw(crop).rounded_rectangle(
            (fx1, fy1, fx1 + bw * out_scale, fy1 + bh * out_scale),
            radius=6, outline=(124, 110, 248), width=3,
        )
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=85)

    return Response(content=buf.getvalue(), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"})
