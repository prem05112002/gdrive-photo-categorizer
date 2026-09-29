import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

from database.models import SessionLocal, Photo, FaceObservation, Person, TripPerson, Trip
from database import crud

UPLOAD_WORKERS = 10   # parallel shortcut creation — Drive write quota tolerates this

_upload_progress: dict[str, dict] = {}


def get_upload_progress(trip_id: str) -> dict | None:
    return _upload_progress.get(trip_id)


# googleapiclient service objects are not thread-safe — one per worker thread.
_tls = threading.local()


def _thread_service():
    from drive.auth import get_drive_service
    if getattr(_tls, "service", None) is None:
        _tls.service = get_drive_service()
    return _tls.service


# ── Drive helpers ───────────────────────────────────────────────────────────────

def create_folder(service, name: str, parent_id: str) -> str:
    meta = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    return service.files().create(body=meta, fields="id").execute()["id"]


def create_shortcut(service, target_file_id: str, name: str, parent_folder_id: str) -> str:
    meta = {
        "name": name,
        "mimeType": "application/vnd.google-apps.shortcut",
        "shortcutDetails": {"targetId": target_file_id},
        "parents": [parent_folder_id],
    }
    return service.files().create(body=meta, fields="id").execute()["id"]


def get_or_create_shortcut(service, target_file_id: str, name: str, parent_folder_id: str) -> str:
    """Idempotent shortcut creation — skips if a shortcut to the same target already exists."""
    resp = service.files().list(
        q=(
            f"name='{name}' and '{parent_folder_id}' in parents"
            f" and mimeType='application/vnd.google-apps.shortcut' and trashed=false"
        ),
        fields="files(id, shortcutDetails)",
    ).execute()
    for f in resp.get("files", []):
        if f.get("shortcutDetails", {}).get("targetId") == target_file_id:
            return f["id"]
    return create_shortcut(service, target_file_id, name, parent_folder_id)


def get_or_create_folder(service, name: str, parent_id: str) -> str:
    folder_id, _ = _get_or_create_folder(service, name, parent_id)
    return folder_id


def _get_or_create_folder(service, name: str, parent_id: str) -> tuple[str, bool]:
    """Returns (folder_id, created) — created=False means it already existed."""
    resp = service.files().list(
        q=f"name='{name}' and '{parent_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields="files(id)",
    ).execute()
    files = resp.get("files", [])
    if files:
        return files[0]["id"], False
    return create_folder(service, name, parent_id), True


# ── Output planner ──────────────────────────────────────────────────────────────

def plan_trip_output(session, trip_id: str) -> list[dict]:
    """
    Decide, from the DB alone, which Drive folder(s) every photo of the trip
    belongs in. One item per shortcut to create:

        {"photo_id", "file_id", "name", "folder": tuple[str, ...], "pid"}

    ``folder`` is a path under [Organized] — ("RAW",), ("Places", label),
    (person_name,) or ("Misc",); ``pid`` is set for person folders so the
    shortcut id can be recorded on that person's face rows.

    The routing rules live in database.crud (misc_photo_filter and friends) and
    are shared with the classify results and the gallery, so the Drive tree
    always matches what the UI shows. No Drive calls — safe to dry-run.
    """
    photos = session.query(Photo).filter(Photo.trip_id == trip_id).all()

    persons: dict[str, Person] = {
        tp.person_id: person
        for tp, person in (
            session.query(TripPerson, Person)
            .join(Person, Person.id == TripPerson.person_id)
            .filter(TripPerson.trip_id == trip_id)
        )
    }

    misc_ids = {pid for (pid,) in session.query(Photo.id).filter(crud.misc_photo_filter(trip_id))}
    places_ids = {pid for (pid,) in session.query(Photo.id).filter(crud.places_photo_filter(trip_id))}

    named_by_photo: dict[str, set[str]] = {}
    named_rows = (
        session.query(FaceObservation.photo_id, FaceObservation.person_id)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(Photo.trip_id == trip_id, FaceObservation.person_id.isnot(None))
        .distinct()
    )
    for photo_id, pid in named_rows:
        named_by_photo.setdefault(photo_id, set()).add(pid)

    plan: list[dict] = []

    def add(photo: Photo, folder: tuple[str, ...], pid: str | None = None) -> None:
        plan.append({
            "photo_id": photo.id,
            "file_id": photo.drive_file_id,
            "name": photo.drive_file_name or f"file_{photo.id}",
            "folder": folder,
            "pid": pid,
        })

    for photo in photos:
        if photo.is_video or photo.is_duplicate:
            continue
        if photo.is_raw:
            add(photo, ("RAW",))
            continue
        if photo.id in places_ids:
            # no faces, or only low-quality / dismissed ones — file by scene
            add(photo, ("Places", photo.scene_label or "other"))
            continue
        for pid in sorted(named_by_photo.get(photo.id, ())):
            if pid in persons:
                add(photo, (persons[pid].name,), pid)
        if photo.id in misc_ids:
            add(photo, ("Misc",))

    return plan


# ── Output builder ──────────────────────────────────────────────────────────────

def build_trip_output(
    service,
    session,
    trip_id: str,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> tuple[int, str]:
    """
    Create [Organized] inside the source Drive folder and populate it with the
    shortcuts plan_trip_output() asks for: per-person folders, Places/{label}/,
    RAW/ and Misc/.

    Folders are created lazily (only the ones the plan needs), then shortcuts
    are created in parallel. Existence checks (1 extra API call per shortcut)
    only run when [Organized] already existed — a fresh tree can't collide.

    Returns (shortcuts_created, root_folder_id).
    """
    trip = session.query(Trip).filter(Trip.id == trip_id).first()
    plan = plan_trip_output(session, trip_id)

    root_id, root_created = _get_or_create_folder(service, "[Organized]", trip.drive_folder_id)
    safe_mode = not root_created  # re-run into an existing tree → dedupe checks needed

    folder_ids: dict[tuple[str, ...], str] = {(): root_id}

    def folder_for(path: tuple[str, ...]) -> str:
        if path not in folder_ids:
            folder_ids[path] = get_or_create_folder(service, path[-1], folder_for(path[:-1]))
        return folder_ids[path]

    worklist = [{**item, "parent_id": folder_for(item["folder"])} for item in plan]

    # ── Execute: parallel shortcut creation ────────────────────────────────
    total = len(worklist)
    shortcuts = 0
    done = 0

    def make(item: dict) -> str:
        svc = _thread_service()
        if safe_mode:
            return get_or_create_shortcut(svc, item["file_id"], item["name"], item["parent_id"])
        return create_shortcut(svc, item["file_id"], item["name"], item["parent_id"])

    with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as pool:
        futures = {pool.submit(make, item): item for item in worklist}
        for fut in as_completed(futures):
            item = futures[fut]
            done += 1
            if progress_callback:
                progress_callback(done, total, item["name"])
            try:
                shortcut_id = fut.result()
            except Exception as e:
                print(f"[upload] warning {item['name']}: {e}")
                continue
            shortcuts += 1
            if item["pid"]:
                session.query(FaceObservation).filter(
                    FaceObservation.photo_id == item["photo_id"],
                    FaceObservation.person_id == item["pid"],
                ).update({"drive_shortcut_id": shortcut_id}, synchronize_session=False)

    session.commit()
    return shortcuts, root_id


# ── Upload thread ───────────────────────────────────────────────────────────────

def _run_upload(trip_id: str) -> None:
    from drive.auth import get_drive_service

    session = SessionLocal()
    try:
        total = session.query(Photo).filter(Photo.trip_id == trip_id).count()
        _upload_progress[trip_id] = {
            "status": "running", "total": total, "uploaded": 0, "current": "Setting up folders…",
        }

        service = get_drive_service()

        def on_progress(done: int, tot: int, name: str) -> None:
            _upload_progress[trip_id].update({"uploaded": done, "total": tot, "current": name})

        shortcuts, root_id = build_trip_output(service, session, trip_id, on_progress)

        session.query(Trip).filter(Trip.id == trip_id).update({"output_folder_id": root_id})
        crud.update_trip_status(session, trip_id, "uploaded")  # also refreshes last_good_status

        _upload_progress[trip_id] = {
            "status": "done",
            "total_shortcuts": shortcuts,
            "output_url": f"https://drive.google.com/drive/folders/{root_id}",
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        _upload_progress[trip_id] = {"status": "error", "error": str(e)}
        try:
            err_s = SessionLocal()
            crud.fail_trip(err_s, trip_id, str(e))
            err_s.close()
        except Exception:
            pass
    finally:
        session.close()


def start_upload_thread(trip_id: str) -> None:
    threading.Thread(target=_run_upload, args=(trip_id,), daemon=True).start()
