import threading

import numpy as np

from database.models import (
    SessionLocal, FaceObservation, Photo, PersonEmbedding, TripPerson, Trip,
)
from database import crud

# Face → person matching. Embeddings are L2-normalized so inner product =
# cosine similarity. Brute-force numpy is exact and instant at this scale
# (hundreds of registry embeddings) — FAISS was removed both as overkill and
# because its bundled libomp segfaulted against PyTorch on macOS ARM64,
# forcing scene classification into a subprocess.
MATCH_THRESHOLD = 0.50   # best person similarity must reach this
MATCH_MARGIN = 0.10      # ...and beat the runner-up person by this (lookalike guard)

_classify_progress: dict[str, dict] = {}


def get_classify_progress(trip_id: str) -> dict | None:
    return _classify_progress.get(trip_id)


def _match_faces(session, trip_id: str) -> int:
    """Match unassigned faces against the full person registry. Returns count matched."""
    emb_rows = session.query(PersonEmbedding).all()
    if not emb_rows:
        return 0

    embs = np.stack([np.frombuffer(r.embedding, dtype=np.float32) for r in emb_rows])  # (N, 512)
    pids = [r.person_id for r in emb_rows]

    unassigned = (
        session.query(FaceObservation)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(
            Photo.trip_id == trip_id,
            FaceObservation.person_id.is_(None),
            FaceObservation.is_stranger == False,
            FaceObservation.raw_embedding.isnot(None),
        )
        .all()
    )
    if not unassigned:
        return 0

    faces = np.stack([np.frombuffer(f.raw_embedding, dtype=np.float32) for f in unassigned])  # (M, 512)
    sims = faces @ embs.T  # (M, N) cosine similarities, one matmul for the whole trip

    # Collapse embedding columns to per-person max similarity → (M, P)
    unique_pids = sorted(set(pids))
    cols = {pid: [i for i, p in enumerate(pids) if p == pid] for pid in unique_pids}
    per_person = np.stack([sims[:, cols[pid]].max(axis=1) for pid in unique_pids], axis=1)

    trip_pid_set = {
        tp.person_id
        for tp in session.query(TripPerson).filter(TripPerson.trip_id == trip_id)
    }

    matched = 0
    for i, face in enumerate(unassigned):
        row = per_person[i]
        best_idx = int(row.argmax())
        best = float(row[best_idx])
        runner_up = float(np.partition(row, -2)[-2]) if len(row) > 1 else -1.0

        if best >= MATCH_THRESHOLD and best - runner_up >= MATCH_MARGIN:
            pid = unique_pids[best_idx]
            face.person_id = pid
            if pid not in trip_pid_set:
                session.add(TripPerson(trip_id=trip_id, person_id=pid))
                trip_pid_set.add(pid)
            matched += 1

    session.commit()
    return matched


def _run_classify(trip_id: str) -> None:
    session = SessionLocal()
    try:
        # ── 1. Face matching (numpy, exact) ────────────────────────────────
        _classify_progress[trip_id] = {"status": "running", "step": "face_match"}
        faces_matched = _match_faces(session, trip_id)

        # ── 2. Scene-label photos that have no label yet (SigLIP 2, in-process) ──
        _classify_progress[trip_id] = {"status": "running", "step": "loading_scene_model"}

        from pipeline.scene import classify_scenes

        def on_progress(done: int, total: int) -> None:
            _classify_progress[trip_id] = {
                "status": "running", "step": "scene_classify",
                "scene_total": total, "scene_processed": done,
            }

        scenes_labeled = classify_scenes(session, trip_id, on_progress)

        session.expire_all()
        crud.update_trip_status(session, trip_id, "classified")  # also refreshes last_good_status
        _classify_progress[trip_id] = {
            "status": "done",
            "faces_matched": faces_matched,
            "scenes_labeled": scenes_labeled,
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        _classify_progress[trip_id] = {"status": "error", "error": str(e)}
        try:
            err_s = SessionLocal()
            crud.fail_trip(err_s, trip_id, str(e))
            err_s.close()
        except Exception:
            pass
    finally:
        session.close()


def start_classify_thread(trip_id: str) -> None:
    threading.Thread(target=_run_classify, args=(trip_id,), daemon=True).start()
