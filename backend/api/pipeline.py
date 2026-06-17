import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from database.models import get_session
from database import crud
from pipeline.face import start_face_pipeline_thread, get_face_progress

router = APIRouter()


@router.post("/{trip_id}/faces", status_code=202)
def start_face_extraction(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    if trip.status not in ("ingested", "failed"):
        raise HTTPException(
            status_code=409,
            detail=f"Face extraction requires status 'ingested', current: '{trip.status}'"
        )
    start_face_pipeline_thread(trip_id)
    return {"status": "started", "trip_id": trip_id}


@router.get("/{trip_id}/faces/progress")
async def stream_face_progress(trip_id: str):
    async def generator():
        while True:
            progress = get_face_progress(trip_id)
            if not progress:
                yield {"data": json.dumps({"status": "waiting"})}
            else:
                yield {"data": json.dumps(progress)}
                if progress.get("status") in ("done", "error"):
                    break
            await asyncio.sleep(0.5)
    return EventSourceResponse(generator())


@router.get("/{trip_id}/faces/stats")
def face_stats(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return crud.get_face_stats(session, trip_id)
