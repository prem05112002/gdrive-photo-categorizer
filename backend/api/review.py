import base64
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database.models import get_session, FaceObservation, Photo, Person, PersonEmbedding, TripPerson
from database import crud

router = APIRouter()


@router.get("/{trip_id}/misc")
def get_misc_faces(trip_id: str, session: Session = Depends(get_session)):
    trip = crud.get_trip(session, trip_id)
    if not trip:
        raise HTTPException(404, "Trip not found")

    rows = (
        session.query(FaceObservation, Photo)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.person_id.is_(None),
            FaceObservation.is_stranger == False,
        )
        .order_by(FaceObservation.confidence.desc())
        .all()
    )

    faces = []
    for face, photo in rows:
        crop_b64 = base64.b64encode(face.face_crop).decode() if face.face_crop else None
        faces.append({
            "face_id": face.id,
            "photo_id": face.photo_id,
            "photo_name": photo.drive_file_name,
            "face_crop": crop_b64,
            "confidence": float(face.confidence) if face.confidence is not None else None,
        })

    return {"faces": faces, "count": len(faces)}


class AssignPayload(BaseModel):
    person_id: str


@router.post("/{trip_id}/misc/{face_id}/assign")
def assign_misc_face(
    trip_id: str, face_id: str, payload: AssignPayload, session: Session = Depends(get_session)
):
    face = session.query(FaceObservation).filter(FaceObservation.id == face_id).first()
    if not face:
        raise HTTPException(404, "Face not found")

    photo = session.query(Photo).filter(Photo.id == face.photo_id).first()
    if not photo or photo.trip_id != trip_id:
        raise HTTPException(404, "Face not in this trip")

    if face.person_id:
        raise HTTPException(409, "Face already assigned")

    person = session.query(Person).filter(Person.id == payload.person_id).first()
    if not person:
        raise HTTPException(404, "Person not found")

    if face.raw_embedding is not None:
        emb = PersonEmbedding(
            person_id=person.id,
            embedding=face.raw_embedding,
            source_photo_id=face.photo_id,
            quality_score=face.confidence,
        )
        session.add(emb)

    face.person_id = person.id
    session.commit()

    return {"assigned": True, "person_id": person.id, "person_name": person.name}


class CreatePersonPayload(BaseModel):
    name: str


@router.post("/{trip_id}/misc/{face_id}/create")
def create_person_from_misc(
    trip_id: str, face_id: str, payload: CreatePersonPayload, session: Session = Depends(get_session)
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "name required")

    face = session.query(FaceObservation).filter(FaceObservation.id == face_id).first()
    if not face:
        raise HTTPException(404, "Face not found")

    photo = session.query(Photo).filter(Photo.id == face.photo_id).first()
    if not photo or photo.trip_id != trip_id:
        raise HTTPException(404, "Face not in this trip")

    if face.person_id:
        raise HTTPException(409, "Face already assigned")

    person = Person(name=name, thumbnail=face.face_crop)
    session.add(person)
    session.flush()

    session.add(TripPerson(trip_id=trip_id, person_id=person.id))

    if face.raw_embedding is not None:
        session.add(PersonEmbedding(
            person_id=person.id,
            embedding=face.raw_embedding,
            source_photo_id=face.photo_id,
            quality_score=face.confidence,
        ))

    face.person_id = person.id
    session.commit()

    return {"person_id": person.id, "name": person.name}
