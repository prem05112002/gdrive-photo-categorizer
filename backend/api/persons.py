from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from database.models import get_session, Person

router = APIRouter()


@router.get("/")
def list_persons(session: Session = Depends(get_session)):
    persons = session.query(Person).order_by(Person.name).all()
    return [{"id": p.id, "name": p.name} for p in persons]


@router.get("/{person_id}/thumbnail")
def get_thumbnail(person_id: str, session: Session = Depends(get_session)):
    person = session.query(Person).filter(Person.id == person_id).first()
    if not person or not person.thumbnail:
        raise HTTPException(404, "Thumbnail not found")
    return Response(content=person.thumbnail, media_type="image/jpeg")
