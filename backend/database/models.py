import uuid
from pathlib import Path
from datetime import datetime
from sqlalchemy import create_engine, Column, String, Boolean, Integer, Float, DateTime, LargeBinary, ForeignKey, Date
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker

_BACKEND_DIR = Path(__file__).parent.parent
DATABASE_URL = f"sqlite:///{_BACKEND_DIR / 'registry.db'}"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def _uuid():
    return str(uuid.uuid4())


class Person(Base):
    __tablename__ = "persons"

    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False)
    thumbnail = Column(LargeBinary)
    created_at = Column(DateTime, default=datetime.utcnow)

    embeddings = relationship("PersonEmbedding", back_populates="person", cascade="all, delete-orphan")
    face_observations = relationship("FaceObservation", back_populates="person")
    trip_links = relationship("TripPerson", back_populates="person")


class PersonEmbedding(Base):
    __tablename__ = "person_embeddings"

    id = Column(String, primary_key=True, default=_uuid)
    person_id = Column(String, ForeignKey("persons.id"), nullable=False)
    embedding = Column(LargeBinary, nullable=False)  # 512-dim float32 numpy bytes
    source_photo_id = Column(String, ForeignKey("photos.id"))
    quality_score = Column(Float)  # frontal angle + sharpness

    person = relationship("Person", back_populates="embeddings")


class Trip(Base):
    __tablename__ = "trips"

    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False)
    drive_folder_id = Column(String, nullable=False)
    # created | ingesting | ingested | extracting_faces | faces_extracted | enrolled | classified | uploaded | body_detecting | body_detected | failed
    status = Column(String, nullable=False, default="created")
    timezone = Column(String, default="UTC")
    expected_member_count = Column(Integer)
    output_folder_id = Column(String)
    last_good_status = Column(String)   # last status before any failure; used for retry UX
    error_message = Column(String)      # stored on failure; persists across server restarts
    created_at = Column(DateTime, default=datetime.utcnow)

    photos = relationship("Photo", back_populates="trip", cascade="all, delete-orphan")
    person_links = relationship("TripPerson", back_populates="trip")


class TripPerson(Base):
    __tablename__ = "trip_persons"

    trip_id = Column(String, ForeignKey("trips.id"), primary_key=True)
    person_id = Column(String, ForeignKey("persons.id"), primary_key=True)

    trip = relationship("Trip", back_populates="person_links")
    person = relationship("Person", back_populates="trip_links")


class Photo(Base):
    __tablename__ = "photos"

    id = Column(String, primary_key=True, default=_uuid)
    trip_id = Column(String, ForeignKey("trips.id"), nullable=False)
    drive_file_id = Column(String, nullable=False)
    drive_file_name = Column(String)
    drive_parent_folder = Column(String)   # sub-folder name (camera owner hint)
    local_path = Column(String)
    file_type = Column(String)             # jpeg | png | heic | raw | video | other
    is_raw = Column(Boolean, default=False)
    is_video = Column(Boolean, default=False)
    is_duplicate = Column(Boolean, default=False)
    duplicate_of_id = Column(String, ForeignKey("photos.id"))
    perceptual_hash = Column(String)
    face_count = Column(Integer, default=0)
    is_group_photo = Column(Boolean, default=False)
    scene_label = Column(String)           # beach | temple | mountain | city | indoor | other
    exif_timestamp = Column(DateTime)
    exif_device = Column(String)

    trip = relationship("Trip", back_populates="photos")
    face_observations = relationship("FaceObservation", back_populates="photo", cascade="all, delete-orphan")


class FaceObservation(Base):
    __tablename__ = "face_observations"

    id = Column(String, primary_key=True, default=_uuid)
    photo_id = Column(String, ForeignKey("photos.id"), nullable=False)
    person_id = Column(String, ForeignKey("persons.id"))    # NULL until enrollment assigns it
    embedding_id = Column(String, ForeignKey("person_embeddings.id"))  # NULL until enrollment
    raw_embedding = Column(LargeBinary)  # 512-dim float32 bytes — populated by face pipeline, cleared after enrollment
    bbox_x = Column(Integer)
    bbox_y = Column(Integer)
    bbox_w = Column(Integer)
    bbox_h = Column(Integer)
    confidence = Column(Float)   # InsightFace det_score (0–1)
    is_stranger = Column(Boolean, default=False)
    face_crop = Column(LargeBinary)  # JPEG bytes of cropped face (256×256)
    drive_shortcut_id = Column(String)  # Drive shortcut file ID in person's folder (set during upload)

    photo = relationship("Photo", back_populates="face_observations")
    person = relationship("Person", back_populates="face_observations")


class UserCorrection(Base):
    __tablename__ = "user_corrections"

    id = Column(String, primary_key=True, default=_uuid)
    trip_id = Column(String, ForeignKey("trips.id"), nullable=False)
    face_observation_id = Column(String, ForeignKey("face_observations.id"))
    old_person_id = Column(String, ForeignKey("persons.id"))
    new_person_id = Column(String, ForeignKey("persons.id"))
    correction_type = Column(String)   # reassigned | dismissed | misc_assigned | misc_created
    status = Column(String, default="pending")  # pending | synced | failed
    created_at = Column(DateTime, default=datetime.utcnow)


class PersonOutfit(Base):
    __tablename__ = "person_outfits"

    id = Column(String, primary_key=True, default=_uuid)
    person_id = Column(String, ForeignKey("persons.id"), nullable=False)
    trip_id = Column(String, ForeignKey("trips.id"), nullable=False)
    date = Column(String, nullable=False)       # ISO date string (YYYY-MM-DD)
    hsv_histogram = Column(LargeBinary, nullable=False)  # 32³ float32 histogram bytes
    photo_count = Column(Integer, default=1)
    updated_at = Column(DateTime, default=datetime.utcnow)


class UnmatchedPerson(Base):
    __tablename__ = "unmatched_persons"

    id = Column(String, primary_key=True, default=_uuid)
    photo_id = Column(String, ForeignKey("photos.id"))
    trip_id = Column(String, ForeignKey("trips.id"), nullable=False)
    bbox_x = Column(Integer)
    bbox_y = Column(Integer)
    bbox_w = Column(Integer)
    bbox_h = Column(Integer)
    hsv_histogram = Column(LargeBinary)
    suggested_person_id = Column(String, ForeignKey("persons.id"))
    suggestion_confidence = Column(Float)
    status = Column(String, default="pending_review")   # pending_review | assigned | dismissed


class PotentialMisclassification(Base):
    __tablename__ = "potential_misclassifications"

    id = Column(String, primary_key=True, default=_uuid)
    face_observation_id = Column(String, ForeignKey("face_observations.id"))
    trip_id = Column(String, ForeignKey("trips.id"), nullable=False)
    current_person_id = Column(String, ForeignKey("persons.id"))
    outfit_suggests_id = Column(String, ForeignKey("persons.id"))
    outfit_correlation = Column(Float)
    status = Column(String, default="pending_review")   # pending_review | confirmed | dismissed


def init_db():
    Base.metadata.create_all(bind=engine)


def get_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
