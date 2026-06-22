import numpy as np
from sklearn.cluster import DBSCAN
from sqlalchemy.orm import Session

from database.models import FaceObservation, Photo


def cluster_faces(session: Session, trip_id: str, eps: float = 0.35, min_samples: int = 1) -> list[dict]:
    """DBSCAN on L2-normalized 512-dim embeddings. eps=0.35 (cosine distance ≤0.35 → similarity ≥0.65), min_samples=1."""
    rows = (
        session.query(FaceObservation)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.raw_embedding.isnot(None),
            FaceObservation.is_stranger == False,
            FaceObservation.person_id.is_(None),
        )
        .all()
    )

    if not rows:
        return []

    embeddings = np.array([
        np.frombuffer(r.raw_embedding, dtype=np.float32) for r in rows
    ])

    labels = DBSCAN(eps=eps, min_samples=min_samples, metric="cosine", n_jobs=-1).fit_predict(embeddings)

    clusters: dict[int, list[FaceObservation]] = {}
    for face, label in zip(rows, labels):
        clusters.setdefault(label, []).append(face)

    result = []
    for label, faces in sorted(clusters.items(), key=lambda x: -len(x[1])):
        top = sorted(faces, key=lambda f: f.confidence or 0.0, reverse=True)[:4]
        result.append({
            "cluster_id": int(label),  # numpy.int64 → Python int for JSON serialization
            "size": len(faces),
            "is_singleton": len(faces) < 3,
            "face_ids": [f.id for f in faces],
            "representative_crops": [f.face_crop for f in top if f.face_crop],
        })

    return result
