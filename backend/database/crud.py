from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Optional
from .models import Trip, Photo, Person, FaceObservation, TripPerson, PersonEmbedding


# ── Face pipeline ──────────────────────────────────────────────────────────────

def get_face_stats(session: Session, trip_id: str) -> dict:
    total_faces = (
        session.query(func.count(FaceObservation.id))
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(Photo.trip_id == trip_id)
        .scalar()
    )
    photos_with_faces = (
        session.query(func.count(Photo.id))
        .filter(Photo.trip_id == trip_id, Photo.face_count > 0)
        .scalar()
    )
    group_candidates = (
        session.query(func.count(Photo.id))
        .filter(Photo.trip_id == trip_id, Photo.is_group_photo == True)
        .scalar()
    )
    return {
        "total_faces": total_faces or 0,
        "photos_with_faces": photos_with_faces or 0,
        "group_photo_candidates": group_candidates or 0,
    }


# ── Trips ──────────────────────────────────────────────────────────────────────

def create_trip(session: Session, trip: Trip) -> Trip:
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return trip


def get_trips(session: Session) -> list[Trip]:
    return session.query(Trip).order_by(Trip.created_at.desc()).all()


def get_trip(session: Session, trip_id: str) -> Optional[Trip]:
    return session.query(Trip).filter(Trip.id == trip_id).first()


def update_trip_status(session: Session, trip_id: str, status: str) -> None:
    update: dict = {"status": status}
    if status != "failed":
        update["last_good_status"] = status
    session.query(Trip).filter(Trip.id == trip_id).update(update)
    session.commit()


def fail_trip(session: Session, trip_id: str, error_message: str) -> None:
    session.query(Trip).filter(Trip.id == trip_id).update({
        "status": "failed",
        "error_message": error_message[:2000],
    })
    session.commit()


# ── Photos ─────────────────────────────────────────────────────────────────────

def create_photo(session: Session, photo: Photo) -> Photo:
    session.add(photo)
    session.commit()
    session.refresh(photo)
    return photo


def get_photos_by_trip(session: Session, trip_id: str) -> list[Photo]:
    return session.query(Photo).filter(Photo.trip_id == trip_id).all()


def find_duplicate(session: Session, trip_id: str, phash: str) -> Optional[Photo]:
    """Return first non-duplicate photo in this trip with the same perceptual hash."""
    return (
        session.query(Photo)
        .filter(
            Photo.trip_id == trip_id,
            Photo.perceptual_hash == phash,
            Photo.is_duplicate == False,
        )
        .first()
    )


def get_trip_photo_counts(session: Session, trip_id: str) -> dict:
    total = session.query(func.count(Photo.id)).filter(Photo.trip_id == trip_id).scalar()
    raw = session.query(func.count(Photo.id)).filter(Photo.trip_id == trip_id, Photo.is_raw == True).scalar()
    video = session.query(func.count(Photo.id)).filter(Photo.trip_id == trip_id, Photo.is_video == True).scalar()
    dupes = session.query(func.count(Photo.id)).filter(Photo.trip_id == trip_id, Photo.is_duplicate == True).scalar()
    return {"photo_count": total or 0, "raw_count": raw or 0, "video_count": video or 0, "duplicate_count": dupes or 0}


# ── Persons ────────────────────────────────────────────────────────────────────

def create_person(session: Session, person: Person) -> Person:
    session.add(person)
    session.commit()
    session.refresh(person)
    return person


def get_persons(session: Session) -> list[Person]:
    return session.query(Person).order_by(Person.name).all()


def get_person(session: Session, person_id: str) -> Optional[Person]:
    return session.query(Person).filter(Person.id == person_id).first()


def add_person_to_trip(session: Session, trip_id: str, person_id: str) -> None:
    exists = session.query(TripPerson).filter(
        TripPerson.trip_id == trip_id,
        TripPerson.person_id == person_id
    ).first()
    if not exists:
        session.add(TripPerson(trip_id=trip_id, person_id=person_id))
        session.commit()
