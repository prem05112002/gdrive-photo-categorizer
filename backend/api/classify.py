import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from database.models import get_session, FaceObservation, Photo, TripPerson, Person
from database import crud
from pipeline.classify import start_classify_thread, get_classify_progress
from drive.output import start_upload_thread, get_upload_progress

router = APIRouter()


@router.post("/{trip_id}/run", status_code=202)
def start_classify(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")
    if trip.status not in ("enrolled", "failed"):
        raise HTTPException(409, f"Classification requires status 'enrolled', current: '{trip.status}'")
    start_classify_thread(trip_id)
    return {"status": "started", "trip_id": trip_id}


@router.get("/{trip_id}/progress")
async def stream_classify_progress(trip_id: str):
    async def gen():
        while True:
            p = get_classify_progress(trip_id)
            yield {"data": json.dumps(p or {"status": "waiting"})}
            if p and p.get("status") in ("done", "error"):
                break
            await asyncio.sleep(0.5)
    return EventSourceResponse(gen())


@router.post("/{trip_id}/upload", status_code=202)
def start_upload(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")
    if trip.status not in ("classified", "failed", "uploaded"):
        raise HTTPException(409, f"Upload requires status 'classified', current: '{trip.status}'")
    start_upload_thread(trip_id)
    return {"status": "started", "trip_id": trip_id}


@router.get("/{trip_id}/upload/progress")
async def stream_upload_progress(trip_id: str):
    async def gen():
        while True:
            p = get_upload_progress(trip_id)
            yield {"data": json.dumps(p or {"status": "waiting"})}
            if p and p.get("status") in ("done", "error"):
                break
            await asyncio.sleep(0.5)
    return EventSourceResponse(gen())


@router.get("/{trip_id}/results")
def get_results(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    trip_persons = session.query(TripPerson).filter(TripPerson.trip_id == trip_id).all()
    persons = []
    for tp in trip_persons:
        person = session.query(Person).filter(Person.id == tp.person_id).first()
        if not person:
            continue
        photo_count = (
            session.query(func.count(func.distinct(FaceObservation.photo_id)))
            .filter(FaceObservation.person_id == tp.person_id)
            .scalar()
        ) or 0
        persons.append({"name": person.name, "person_id": person.id, "photo_count": photo_count})

    persons.sort(key=lambda x: -x["photo_count"])

    scene_photos = (
        session.query(Photo)
        .filter(Photo.trip_id == trip_id, Photo.face_count == 0, Photo.scene_label.isnot(None))
        .all()
    )
    scene_counts: dict[str, int] = {}
    for p in scene_photos:
        scene_counts[p.scene_label] = scene_counts.get(p.scene_label, 0) + 1

    misc_count = (
        session.query(func.count(func.distinct(FaceObservation.photo_id)))
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.person_id.is_(None),
            FaceObservation.is_stranger == False,
        )
        .scalar()
    ) or 0

    return {"persons": persons, "scene_counts": scene_counts, "misc_count": misc_count}
