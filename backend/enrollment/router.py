import base64
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, distinct
from sqlalchemy.orm import Session

from database.models import get_session, FaceObservation, Photo, Person, PersonEmbedding, TripPerson
from database import crud
from enrollment.cluster import cluster_faces

router = APIRouter()


@router.get("/{trip_id}/group-photos")
def get_group_photos(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    photos = (
        session.query(Photo)
        .filter(Photo.trip_id == trip_id, Photo.is_group_photo == True)
        .order_by(Photo.face_count.desc())
        .all()
    )

    result = []
    for photo in photos:
        faces = (
            session.query(FaceObservation)
            .filter(FaceObservation.photo_id == photo.id, FaceObservation.face_crop.isnot(None))
            .order_by(FaceObservation.confidence.desc())
            .limit(6)
            .all()
        )
        result.append({
            "id": photo.id,
            "file_name": photo.drive_file_name,
            "face_count": photo.face_count,
            "face_crops": [base64.b64encode(f.face_crop).decode() for f in faces],
        })

    return result


@router.get("/{trip_id}/clusters")
def get_clusters(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")
    if trip.status not in ("faces_extracted", "enrolled", "failed"):
        raise HTTPException(409, f"Clustering requires status 'faces_extracted', current: '{trip.status}'")

    clusters = cluster_faces(session, trip_id)

    named = (
        session.query(func.count(distinct(TripPerson.person_id)))
        .filter(TripPerson.trip_id == trip_id)
        .scalar()
    ) or 0

    return {
        "clusters": [
            {
                "cluster_id": c["cluster_id"],
                "size": c["size"],
                "is_singleton": c["is_singleton"],
                "face_ids": c["face_ids"],
                "representative_crops": [
                    base64.b64encode(crop).decode() for crop in c["representative_crops"]
                ],
            }
            for c in clusters
        ],
        "total_faces_pending": sum(c["size"] for c in clusters),
        "named": named,
        "expected": trip.expected_member_count,
    }


class NameClusterPayload(BaseModel):
    name: str
    face_ids: list[str]


@router.post("/{trip_id}/name-cluster")
def name_cluster(trip_id: str, payload: NameClusterPayload, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    faces = session.query(FaceObservation).filter(FaceObservation.id.in_(payload.face_ids)).all()
    if not faces:
        raise HTTPException(404, "No faces found for given IDs")

    best_face = max(faces, key=lambda f: f.confidence or 0.0)
    person = Person(name=payload.name.strip(), thumbnail=best_face.face_crop)
    session.add(person)
    session.flush()

    session.add(TripPerson(trip_id=trip_id, person_id=person.id))

    for face in faces:
        if face.raw_embedding:
            session.add(PersonEmbedding(
                person_id=person.id,
                embedding=face.raw_embedding,
                source_photo_id=face.photo_id,
                quality_score=face.confidence,
            ))
        face.person_id = person.id

    if trip.status == "faces_extracted":
        trip.status = "enrolled"

    session.commit()
    return {"person_id": person.id, "name": person.name}


class DismissPayload(BaseModel):
    face_ids: list[str]


@router.post("/{trip_id}/dismiss-cluster")
def dismiss_cluster(trip_id: str, payload: DismissPayload, session: Session = Depends(get_session)):
    updated = (
        session.query(FaceObservation)
        .filter(FaceObservation.id.in_(payload.face_ids))
        .update({"is_stranger": True}, synchronize_session=False)
    )
    session.commit()
    return {"dismissed": updated}


@router.get("/{trip_id}/coverage")
def get_coverage(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    named = (
        session.query(func.count(distinct(TripPerson.person_id)))
        .filter(TripPerson.trip_id == trip_id)
        .scalar()
    ) or 0

    return {"named": named, "expected": trip.expected_member_count}
