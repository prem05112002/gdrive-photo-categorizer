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


# ── Output builder ──────────────────────────────────────────────────────────────

def build_trip_output(
    service,
    session,
    trip_id: str,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> tuple[int, str]:
    """
    Create [Organized] subfolder inside the source Drive folder and populate it
    with per-person shortcuts, Places/{label}/ shortcuts, RAW shortcuts, and
    Misc shortcuts for photos with unmatched faces.

    Plans the full shortcut worklist from the DB first, then creates shortcuts
    in parallel. Existence checks (1 extra API call per shortcut) only run when
    the [Organized] folder already existed — a fresh output tree can't have
    collisions.

    Returns (shortcuts_created, root_folder_id).
    """
    trip = session.query(Trip).filter(Trip.id == trip_id).first()
    photos = session.query(Photo).filter(Photo.trip_id == trip_id).all()

    trip_persons = session.query(TripPerson).filter(TripPerson.trip_id == trip_id).all()
    persons: dict[str, Person] = {}
    for tp in trip_persons:
        p = session.query(Person).filter(Person.id == tp.person_id).first()
        if p:
            persons[tp.person_id] = p

    root_id, root_created = _get_or_create_folder(service, "[Organized]", trip.drive_folder_id)
    safe_mode = not root_created  # re-run into an existing tree → dedupe checks needed

    # ── Plan: folders needed + one worklist item per shortcut ──────────────
    person_folders: dict[str, str] = {
        pid: get_or_create_folder(service, person.name, root_id)
        for pid, person in persons.items()
    }

    places_id: str | None = None
    place_sub: dict[str, str] = {}
    misc_id: str | None = None
    raw_id: str | None = None

    worklist: list[dict] = []  # {file_id, name, parent_id, pid?, photo_id}

    for photo in photos:
        fname = photo.drive_file_name or f"file_{photo.id}"

        if photo.is_video or photo.is_duplicate:
            continue

        if photo.is_raw:
            if raw_id is None:
                raw_id = get_or_create_folder(service, "RAW", root_id)
            worklist.append({"file_id": photo.drive_file_id, "name": fname,
                             "parent_id": raw_id, "pid": None, "photo_id": photo.id})
            continue

        if photo.face_count == 0:
            label = photo.scene_label or "other"
            if places_id is None:
                places_id = get_or_create_folder(service, "Places", root_id)
            if label not in place_sub:
                place_sub[label] = get_or_create_folder(service, label, places_id)
            worklist.append({"file_id": photo.drive_file_id, "name": fname,
                             "parent_id": place_sub[label], "pid": None, "photo_id": photo.id})
            continue

        faces = session.query(FaceObservation).filter(FaceObservation.photo_id == photo.id).all()
        named_pids = {f.person_id for f in faces if f.person_id}
        has_unmatched = any(not f.person_id and not f.is_stranger for f in faces)

        for pid in named_pids:
            if pid in person_folders:
                worklist.append({"file_id": photo.drive_file_id, "name": fname,
                                 "parent_id": person_folders[pid], "pid": pid, "photo_id": photo.id})

        if has_unmatched:
            if misc_id is None:
                misc_id = get_or_create_folder(service, "Misc", root_id)
            worklist.append({"file_id": photo.drive_file_id, "name": fname,
                             "parent_id": misc_id, "pid": None, "photo_id": photo.id})

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

        session.query(Trip).filter(Trip.id == trip_id).update({
            "status": "uploaded",
            "output_folder_id": root_id,
        })
        session.commit()

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
