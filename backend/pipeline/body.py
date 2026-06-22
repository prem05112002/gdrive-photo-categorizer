import json
import subprocess
import sys
import threading
from pathlib import Path

from database.models import SessionLocal, Trip
from database import crud

_body_progress: dict[str, dict] = {}
_WORKER = Path(__file__).parent / "body_detect_worker.py"


def get_body_progress(trip_id: str) -> dict | None:
    return _body_progress.get(trip_id)


def _run_body(trip_id: str) -> None:
    session = SessionLocal()
    try:
        _body_progress[trip_id] = {"status": "running", "step": "loading_model"}
        session.query(Trip).filter(Trip.id == trip_id).update({"status": "body_detecting"})
        session.commit()

        proc = subprocess.Popen(
            [sys.executable, str(_WORKER), trip_id],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(Path(__file__).parent.parent),
        )

        total: int | None = None
        result_stats: dict = {}

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                if data.get("status") == "loading_model":
                    _body_progress[trip_id] = {"status": "running", "step": "loading_model"}
                elif "progress" in data:
                    if total is None:
                        total = data.get("total", 1)
                    _body_progress[trip_id] = {
                        "status": "running",
                        "step": "detecting",
                        "processed": data["progress"] + 1,
                        "total": total or 1,
                    }
                elif "bodies_found" in data:
                    result_stats = data
                elif "warning" in data:
                    pass  # non-fatal per-photo error
            except Exception:
                pass

        proc.wait()
        if proc.returncode != 0:
            stderr = proc.stderr.read()
            raise RuntimeError(f"Body detection subprocess failed: {stderr}")

        session.expire_all()
        session.query(Trip).filter(Trip.id == trip_id).update({
            "status": "body_detected",
            "last_good_status": "body_detected",
        })
        session.commit()
        _body_progress[trip_id] = {"status": "done", **result_stats}

    except Exception as e:
        import traceback
        traceback.print_exc()
        _body_progress[trip_id] = {"status": "error", "error": str(e)}
        try:
            err_s = SessionLocal()
            crud.fail_trip(err_s, trip_id, str(e))
            err_s.close()
        except Exception:
            pass
    finally:
        session.close()


def start_body_thread(trip_id: str) -> None:
    threading.Thread(target=_run_body, args=(trip_id,), daemon=True).start()
