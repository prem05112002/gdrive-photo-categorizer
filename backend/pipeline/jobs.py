"""
One background thread per (step, trip).

Until the jobs table (stage 2) replaces the in-memory progress dicts, this is
the guard against the same step running twice on a trip: a reload mid-upload
showed the "Upload to Drive" button again, and a second click would have raced
the first thread into duplicate person folders and shortcuts. It also resets
the step's progress before the thread starts, so a subscriber never reads the
previous run's "done"/"error" and closes its stream on a run that has just
begun.
"""
import threading
from typing import Callable

_lock = threading.Lock()
_threads: dict[tuple[str, str], threading.Thread] = {}


class JobRunning(Exception):
    """The same step is still running for this trip."""


def start(step: str, trip_id: str, target: Callable[[str], None], reset_progress: Callable[[], None]) -> None:
    with _lock:
        running = _threads.get((step, trip_id))
        if running is not None and running.is_alive():
            raise JobRunning(f"{step} is already running for this trip")
        reset_progress()
        thread = threading.Thread(target=target, args=(trip_id,), daemon=True, name=f"{step}:{trip_id}")
        _threads[(step, trip_id)] = thread
        thread.start()


def is_running(step: str, trip_id: str) -> bool:
    thread = _threads.get((step, trip_id))
    return thread is not None and thread.is_alive()
