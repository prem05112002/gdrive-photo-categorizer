import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database.models import Trip, get_session
from database.schemas import TripCreate, TripResponse
from database import crud
from drive.ingest import extract_folder_id

router = APIRouter()


def _enrich(trip: Trip, session: Session) -> TripResponse:
    counts = crud.get_trip_photo_counts(session, trip.id)
    return TripResponse(
        id=trip.id,
        name=trip.name,
        drive_folder_id=trip.drive_folder_id,
        status=trip.status,
        expected_member_count=trip.expected_member_count,
        output_folder_id=trip.output_folder_id,
        last_good_status=trip.last_good_status,
        error_message=trip.error_message,
        created_at=trip.created_at,
        **counts,
    )


@router.get("/", response_model=list[TripResponse])
def list_trips(session: Session = Depends(get_session)):
    trips = crud.get_trips(session)
    return [_enrich(t, session) for t in trips]


@router.post("/", response_model=TripResponse, status_code=201)
def create_trip(data: TripCreate, session: Session = Depends(get_session)):
    folder_id = extract_folder_id(data.drive_folder_url)
    if not folder_id:
        raise HTTPException(status_code=422, detail="Could not extract folder ID from URL")

    trip = Trip(
        id=str(uuid.uuid4()),
        name=data.name,
        drive_folder_id=folder_id,
        expected_member_count=data.expected_member_count,
    )
    created = crud.create_trip(session, trip)
    return _enrich(created, session)


@router.get("/{trip_id}", response_model=TripResponse)
def get_trip(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return _enrich(trip, session)


@router.delete("/{trip_id}", status_code=204)
def delete_trip(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    session.delete(trip)
    session.commit()
