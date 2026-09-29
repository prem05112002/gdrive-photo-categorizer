import base64

import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sqlalchemy.orm import Session

from database import crud
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
REP_COUNT = 6   # sample faces returned per cluster for the enroll UI


def cluster_faces(session: Session, trip_id: str) -> list[dict]:
    rows = (
        session.query(FaceObservation)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.raw_embedding.isnot(None),
            # unassigned, not dismissed, passes the quality gate — junk never reaches review
            crud.routable_unmatched_face_filter(),
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
        reps = _pick_representatives(faces, REP_COUNT)
        suggested = suggestions.get(idxs[0]) if len(idxs) == 1 else None
        result.append({
            "cluster_id": int(label),  # numpy.int64 → Python int for JSON serialization
            "size": len(faces),
            "photo_count": len({f.photo_id for f in faces}),
            "is_singleton": len(faces) < 3,
            "face_ids": [f.id for f in faces],
            "representatives": reps,  # FaceObservation rows, best first
            "representative_crops": [f.face_crop for f in reps],
            "suggested_cluster_id": int(suggested) if suggested is not None else None,
        })

    return result


def _pick_representatives(faces: list[FaceObservation], k: int) -> list[FaceObservation]:
    """
    Best-first sample of a cluster for display: highest detector confidence,
    then sharpest, spread across different photos so one burst doesn't fill
    every slot. Faces without a stored crop are skipped.
    """
    ranked = sorted(
        (f for f in faces if f.face_crop),
        key=lambda f: (f.confidence or 0.0, f.blur_score or 0.0),
        reverse=True,
    )
    picked: list[FaceObservation] = []
    seen_photos: set[str] = set()
    for f in ranked:
        if f.photo_id not in seen_photos:
            picked.append(f)
            seen_photos.add(f.photo_id)
        if len(picked) == k:
            return picked
    for f in ranked:
        if len(picked) == k:
            break
        if f not in picked:
            picked.append(f)
    return picked


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


def representatives_payload(session: Session, clusters: list[dict]) -> dict[int, list[dict]]:
    """
    JSON-ready sample faces per cluster_id (face_id, photo_id, file_name, bbox,
    base64 crop) — what the Enroll and Review pages render as hero + samples and
    open in the face-in-context lightbox. One query for all file names.
    """
    photo_ids = {f.photo_id for c in clusters for f in c["representatives"]}
    file_names: dict[str, str | None] = dict(
        session.query(Photo.id, Photo.drive_file_name).filter(Photo.id.in_(photo_ids)).all()
    ) if photo_ids else {}
    return {
        c["cluster_id"]: [
            {
                "face_id": f.id,
                "photo_id": f.photo_id,
                "file_name": file_names.get(f.photo_id),
                "bbox_x": f.bbox_x,
                "bbox_y": f.bbox_y,
                "bbox_w": f.bbox_w,
                "bbox_h": f.bbox_h,
                "crop": base64.b64encode(f.face_crop).decode(),
            }
            for f in c["representatives"]
        ]
        for c in clusters
    }
