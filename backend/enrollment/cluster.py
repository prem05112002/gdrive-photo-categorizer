import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sqlalchemy.orm import Session

from database.models import FaceObservation, Photo

# Two-stage clustering on L2-normalized 512-dim ArcFace embeddings.
#
# Stage 1 — conservative agglomerative clustering (average linkage, cosine).
#   Groups only faces whose average pairwise distance ≤ CLUSTER_DISTANCE_THRESHOLD.
#   High precision: a cluster is virtually never two different people.
#
# Stage 2 — singleton attachment. Faces left alone by stage 1 (odd pose,
#   sunglasses, partial occlusion) are compared against each cluster's top-K
#   most-confident embeddings:
#     max-sim ≥ ATTACH_SIM   → merged into the cluster automatically
#     max-sim ≥ SUGGEST_SIM  → kept as singleton, tagged suggested_cluster_id
#     below                  → plain singleton (likely stranger)
#
# ArcFace cosine similarity: same person typically ≥ 0.45–0.5 across pose
# changes; different people rarely exceed 0.35.
CLUSTER_DISTANCE_THRESHOLD = 0.45
ATTACH_SIM = 0.50
SUGGEST_SIM = 0.38
REP_TOP_K = 5


def cluster_faces(session: Session, trip_id: str) -> list[dict]:
    rows = (
        session.query(FaceObservation)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.raw_embedding.isnot(None),
            FaceObservation.is_stranger == False,
            FaceObservation.person_id.is_(None),
            FaceObservation.is_low_quality == False,  # quality gate — junk never reaches review
        )
        .all()
    )

    if not rows:
        return []

    embeddings = np.array([
        np.frombuffer(r.raw_embedding, dtype=np.float32) for r in rows
    ])

    if len(rows) == 1:
        labels = np.array([0])
    else:
        labels = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=CLUSTER_DISTANCE_THRESHOLD,
            metric="cosine",
            linkage="average",
        ).fit_predict(embeddings)

    # Group face indices by label
    groups: dict[int, list[int]] = {}
    for i, label in enumerate(labels):
        groups.setdefault(int(label), []).append(i)

    cores = {label: idxs for label, idxs in groups.items() if len(idxs) >= 2}
    single_idxs = [idxs[0] for idxs in groups.values() if len(idxs) == 1]

    # Stage 2 — try to attach each singleton to an existing core cluster
    suggestions: dict[int, int] = {}  # face index → suggested core label
    if cores and single_idxs:
        reps = {}
        for label, idxs in cores.items():
            top = sorted(idxs, key=lambda i: rows[i].confidence or 0.0, reverse=True)[:REP_TOP_K]
            reps[label] = embeddings[top]  # (k, 512)

        still_single = []
        for i in single_idxs:
            best_label, best_sim = None, -1.0
            for label, rep in reps.items():
                sim = float(np.max(rep @ embeddings[i]))
                if sim > best_sim:
                    best_sim, best_label = sim, label
            if best_sim >= ATTACH_SIM:
                cores[best_label].append(i)
            else:
                if best_sim >= SUGGEST_SIM:
                    suggestions[i] = best_label
                still_single.append(i)
        single_idxs = still_single

    # Build response — cores first (largest first), then singletons
    clusters: list[tuple[int, list[int]]] = sorted(cores.items(), key=lambda x: -len(x[1]))
    clusters += [(int(labels[i]), [i]) for i in single_idxs]

    result = []
    for label, idxs in clusters:
        faces = [rows[i] for i in idxs]
        top = sorted(faces, key=lambda f: f.confidence or 0.0, reverse=True)[:4]
        suggested = suggestions.get(idxs[0]) if len(idxs) == 1 else None
        result.append({
            "cluster_id": int(label),  # numpy.int64 → Python int for JSON serialization
            "size": len(faces),
            "is_singleton": len(faces) < 3,
            "face_ids": [f.id for f in faces],
            "representative_crops": [f.face_crop for f in top if f.face_crop],
            "suggested_cluster_id": int(suggested) if suggested is not None else None,
        })

    return result


def count_low_quality(session: Session, trip_id: str) -> int:
    """Unassigned faces hidden from enrollment by the quality gate."""
    return (
        session.query(FaceObservation)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.person_id.is_(None),
            FaceObservation.is_stranger == False,
            FaceObservation.is_low_quality == True,
        )
        .count()
    )
