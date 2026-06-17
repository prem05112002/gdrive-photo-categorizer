import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from database.models import get_session
from database import crud
from drive.ingest import start_ingestion_thread, get_progress

router = APIRouter()


@router.post("/{trip_id}/ingest", status_code=202)
def start_ingestion(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    if trip.status == "ingesting":
        raise HTTPException(status_code=409, detail="Ingestion already in progress")

    start_ingestion_thread(trip_id)
    return {"status": "started", "trip_id": trip_id}


@router.get("/{trip_id}/progress")
async def stream_progress(trip_id: str):
    """SSE endpoint — streams ingestion progress until done or error."""

    async def generator():
        while True:
            progress = get_progress(trip_id)

            if not progress:
                # Not started yet — send a waiting heartbeat
                yield {"data": json.dumps({"status": "waiting"})}
            else:
                yield {"data": json.dumps(progress)}
                if progress.get("status") in ("done", "error"):
                    break

            await asyncio.sleep(0.5)

    return EventSourceResponse(generator())


@router.get("/{trip_id}/photos")
def list_trip_photos(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    photos = crud.get_photos_by_trip(session, trip_id)
    return [
        {
            "id": p.id,
            "name": p.drive_file_name,
            "type": p.file_type,
            "is_raw": p.is_raw,
            "is_duplicate": p.is_duplicate,
            "device": p.exif_device,
            "parent_folder": p.drive_parent_folder,
        }
        for p in photos
    ]
