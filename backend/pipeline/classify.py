import json
import subprocess
import sys
import threading
from pathlib import Path

import faiss
import numpy as np

from database.models import (
    SessionLocal, FaceObservation, Photo, PersonEmbedding, TripPerson, Trip,
)
from database import crud

_classify_progress: dict[str, dict] = {}

_WORKER = Path(__file__).parent / "scene_classify_worker.py"


def get_classify_progress(trip_id: str) -> dict | None:
    return _classify_progress.get(trip_id)


def _run_classify(trip_id: str) -> None:
    session = SessionLocal()
    try:
        _classify_progress[trip_id] = {"status": "running", "step": "face_match"}

        # ── 1. FAISS: match any unassigned faces against full registry ─────────
        emb_rows = session.query(PersonEmbedding).all()
        faces_matched = 0

        if emb_rows:
            embs = np.array([np.frombuffer(r.embedding, dtype=np.float32) for r in emb_rows])
            index = faiss.IndexFlatIP(512)
            index.add(embs)
            pid_map = [r.person_id for r in emb_rows]

            trip_pid_set = {
                tp.person_id
                for tp in session.query(TripPerson).filter(TripPerson.trip_id == trip_id)
            }

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

            for face in unassigned:
                emb = np.frombuffer(face.raw_embedding, dtype=np.float32).reshape(1, -1)
                D, I = index.search(emb, k=1)
                if float(D[0][0]) >= 0.5:
                    best_pid = pid_map[int(I[0][0])]
                    face.person_id = best_pid
                    if best_pid not in trip_pid_set:
                        session.add(TripPerson(trip_id=trip_id, person_id=best_pid))
                        trip_pid_set.add(best_pid)
                    faces_matched += 1

            session.commit()

        # ── 2. OpenCLIP: scene-label no-face photos via subprocess ────────────
        # FAISS and PyTorch both ship libomp.dylib. Loading both in the same
        # process causes a SIGSEGV on macOS ARM64. Run scene classification
        # in a fresh subprocess where FAISS is never imported.
        no_face_count = (
            session.query(Photo)
            .filter(
                Photo.trip_id == trip_id,
                Photo.face_count == 0,
                Photo.is_raw == False,
                Photo.is_video == False,
                Photo.is_duplicate == False,
            )
            .count()
        )

        scenes_labeled = 0
        if no_face_count > 0:
            _classify_progress[trip_id] = {
                "status": "running", "step": "loading_scene_model",
            }

            proc = subprocess.Popen(
                [sys.executable, str(_WORKER), trip_id],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(Path(__file__).parent.parent),
            )

            _classify_progress[trip_id] = {
                "status": "running", "step": "scene_classify",
                "scene_total": no_face_count, "scene_processed": 0,
            }

            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    if "progress" in data:
                        _classify_progress[trip_id]["scene_processed"] = data["progress"] + 1
                    if "labeled" in data:
                        scenes_labeled = data["labeled"]
                except Exception:
                    pass

            proc.wait()
            if proc.returncode != 0:
                stderr = proc.stderr.read()
                raise RuntimeError(f"Scene classification subprocess failed: {stderr}")

        session.expire_all()
        session.query(Trip).filter(Trip.id == trip_id).update({"status": "classified"})
        session.commit()
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
