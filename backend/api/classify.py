import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from database.models import get_session, FaceObservation, Photo, TripPerson, Person
from database import crud
from pipeline.jobs import JobRunning
from pipeline.classify import start_classify_thread, get_classify_progress
from drive.output import start_upload_thread, get_upload_progress

router = APIRouter()


@router.post("/{trip_id}/run", status_code=202)
def start_classify(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")
    # Re-running on a classified trip is idempotent: matching only touches
    # unassigned faces, scene labelling only fills photos without a label.
    if trip.status not in ("enrolled", "classified", "uploaded", "body_detected", "failed"):
        raise HTTPException(409, f"Classification requires status 'enrolled' or later, current: '{trip.status}'")
    try:
        start_classify_thread(trip_id)
    except JobRunning as e:
        raise HTTPException(409, str(e))
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
    if trip.status not in ("classified", "failed", "uploaded", "body_detected"):
        raise HTTPException(409, f"Upload requires status 'classified', current: '{trip.status}'")
    try:
        start_upload_thread(trip_id)
    except JobRunning as e:
        raise HTTPException(409, str(e))
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
            .join(Photo, Photo.id == FaceObservation.photo_id)
            .filter(Photo.trip_id == trip_id, FaceObservation.person_id == tp.person_id)
            .scalar()
        ) or 0
        persons.append({"name": person.name, "person_id": person.id, "photo_count": photo_count})

    persons.sort(key=lambda x: -x["photo_count"])

    # Places = photos with no routable face (crud.places_photo_filter), bucketed
    # by scene label; unlabelled ones count as "other", exactly as the Drive
    # output files them.
    scene_label = func.coalesce(Photo.scene_label, "other")
    scene_counts: dict[str, int] = {
        label: count
        for label, count in (
            session.query(scene_label, func.count(Photo.id))
            .filter(crud.places_photo_filter(trip_id))
            .group_by(scene_label)
        )
    }

    misc_count = (
        session.query(func.count(Photo.id))
        .filter(crud.misc_photo_filter(trip_id))
        .scalar()
    ) or 0

    return {"persons": persons, "scene_counts": scene_counts, "misc_count": misc_count}
