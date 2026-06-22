import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database.models import get_session, FaceObservation, Photo, Person, TripPerson, Trip, UserCorrection
from database import crud
from drive.output import get_or_create_folder, get_or_create_shortcut

trips_router = APIRouter()
face_obs_router = APIRouter()

_TEMP = Path(__file__).parent.parent / "temp"


# ── Reassign ───────────────────────────────────────────────────────────────────

class ReassignPayload(BaseModel):
    new_person_id: str


@face_obs_router.patch("/{face_obs_id}/reassign")
def reassign_face(
    face_obs_id: str,
    payload: ReassignPayload,
    session: Session = Depends(get_session),
):
    face = session.query(FaceObservation).filter(FaceObservation.id == face_obs_id).first()
    if not face:
        raise HTTPException(404, "Face observation not found")

    photo = session.query(Photo).filter(Photo.id == face.photo_id).first()
    if not photo:
        raise HTTPException(404, "Photo not found")

    if not session.query(Person).filter(Person.id == payload.new_person_id).first():
        raise HTTPException(404, "Person not found")

    if face.person_id == payload.new_person_id:
        raise HTTPException(400, "Face already assigned to this person")

    old_person_id = face.person_id
    face.person_id = payload.new_person_id

    correction = UserCorrection(
        trip_id=photo.trip_id,
        face_observation_id=face_obs_id,
        old_person_id=old_person_id,
        new_person_id=payload.new_person_id,
        correction_type="reassigned",
        status="pending",
    )
    session.add(correction)
    session.commit()
    session.refresh(correction)

    pending_count = session.query(func.count(UserCorrection.id)).filter(
        UserCorrection.trip_id == photo.trip_id,
        UserCorrection.status == "pending",
    ).scalar()

    return {"correction_id": correction.id, "pending_count": int(pending_count)}


# ── Sync to Drive ──────────────────────────────────────────────────────────────

@trips_router.post("/{trip_id}/sync")
def sync_trip(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    if not trip.output_folder_id:
        raise HTTPException(409, "Trip has no output folder — run upload first")

    pending = (
        session.query(UserCorrection)
        .filter(UserCorrection.trip_id == trip_id, UserCorrection.status == "pending")
        .all()
    )

    if not pending:
        return {"synced": 0, "failed": []}

    from drive.auth import get_drive_service
    service = get_drive_service()

    synced = 0
    failed = []

    for correction in pending:
        try:
            face = session.query(FaceObservation).filter(
                FaceObservation.id == correction.face_observation_id
            ).first()
            if not face:
                raise ValueError("Face observation not found")

            photo = session.query(Photo).filter(Photo.id == face.photo_id).first()
            if not photo:
                raise ValueError("Photo not found")

            new_person = session.query(Person).filter(Person.id == correction.new_person_id).first()
            if not new_person:
                raise ValueError("New person not found")

            # Delete old shortcut from Drive
            if face.drive_shortcut_id:
                try:
                    service.files().delete(fileId=face.drive_shortcut_id).execute()
                except Exception:
                    pass  # Not found or already deleted — continue

            # Create shortcut in new person's folder
            new_folder_id = get_or_create_folder(service, new_person.name, trip.output_folder_id)
            fname = photo.drive_file_name or f"photo_{photo.id}"
            new_shortcut_id = get_or_create_shortcut(service, photo.drive_file_id, fname, new_folder_id)

            face.drive_shortcut_id = new_shortcut_id
            correction.status = "synced"
            session.commit()
            synced += 1

        except Exception as e:
            correction.status = "failed"
            session.commit()
            failed.append({"correction_id": correction.id, "error": str(e)})

    return {"synced": synced, "failed": failed}


# ── Sync status ────────────────────────────────────────────────────────────────

@trips_router.get("/{trip_id}/sync-status")
def sync_status(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    # Tier 1: count pending corrections
    pending_count = int(
        session.query(func.count(UserCorrection.id))
        .filter(UserCorrection.trip_id == trip_id, UserCorrection.status == "pending")
        .scalar()
    )

    if pending_count > 0:
        return {"pending_count": pending_count, "mismatches": []}

    # Tier 2: Drive verification (only when no pending corrections)
    if not trip.output_folder_id:
        return {"pending_count": 0, "mismatches": []}

    from drive.auth import get_drive_service
    service = get_drive_service()

    enrolled = (
        session.query(Person, TripPerson)
        .join(TripPerson, TripPerson.person_id == Person.id)
        .filter(TripPerson.trip_id == trip_id)
        .all()
    )

    mismatches = []
    for person, _ in enrolled:
        # DB count: distinct photos this person appears in (matches how output.py creates shortcuts)
        db_count = int(
            session.query(func.count(func.distinct(FaceObservation.photo_id)))
            .join(Photo, Photo.id == FaceObservation.photo_id)
            .filter(
                Photo.trip_id == trip_id,
                FaceObservation.person_id == person.id,
                FaceObservation.is_stranger == False,
            )
            .scalar()
        )

        # Drive count: shortcuts in this person's folder
        folder_resp = service.files().list(
            q=(
                f"name='{person.name}' and '{trip.output_folder_id}' in parents"
                " and mimeType='application/vnd.google-apps.folder' and trashed=false"
            ),
            fields="files(id)",
        ).execute()

        folders = folder_resp.get("files", [])
        if not folders:
            drive_count = 0
        else:
            shortcuts_resp = service.files().list(
                q=(
                    f"'{folders[0]['id']}' in parents"
                    " and mimeType='application/vnd.google-apps.shortcut' and trashed=false"
                ),
                fields="files(id)",
                pageSize=1000,
            ).execute()
            drive_count = len(shortcuts_resp.get("files", []))

        if drive_count != db_count:
            mismatches.append({
                "person_name": person.name,
                "db_count": db_count,
                "drive_count": drive_count,
            })

    return {"pending_count": 0, "mismatches": mismatches}


# ── Cache clear ────────────────────────────────────────────────────────────────

@trips_router.delete("/{trip_id}/cache")
def clear_cache(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    trip_dir = _TEMP / trip_id
    if not trip_dir.exists():
        raise HTTPException(404, "Cache directory not found — already cleared?")

    # Guard: check pending corrections
    pending_count = int(
        session.query(func.count(UserCorrection.id))
        .filter(UserCorrection.trip_id == trip_id, UserCorrection.status == "pending")
        .scalar()
    )
    if pending_count > 0:
        raise HTTPException(409, f"Cannot clear cache: {pending_count} pending correction(s). Sync to Drive first.")

    freed_bytes = sum(f.stat().st_size for f in trip_dir.rglob("*") if f.is_file())
    shutil.rmtree(trip_dir)

    return {"freed_bytes": freed_bytes}
