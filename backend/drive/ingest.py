import uuid
import threading
from pathlib import Path
from typing import Callable

from googleapiclient.http import MediaIoBaseDownload

from database.models import SessionLocal, Photo, Trip
from database import crud
from utils.image import get_file_type, is_supported_file, compute_phash, extract_exif

TEMP_DIR = Path(__file__).parent.parent / "temp"


# ── Progress tracking (in-memory, single-user tool) ───────────────────────────

_progress: dict[str, dict] = {}
_locks: dict[str, threading.Lock] = {}


def get_progress(trip_id: str) -> dict:
    return _progress.get(trip_id, {})


def _update(trip_id: str, **kwargs) -> None:
    if trip_id not in _progress:
        _progress[trip_id] = {}
    _progress[trip_id].update(kwargs)


# ── Drive helpers ──────────────────────────────────────────────────────────────

def extract_folder_id(url_or_id: str) -> str:
    """Extract the bare folder ID from a Drive share URL or return the ID as-is."""
    if "drive.google.com" in url_or_id:
        # Handles both:
        #   https://drive.google.com/drive/folders/FOLDER_ID
        #   https://drive.google.com/drive/u/0/folders/FOLDER_ID?usp=sharing
        clean = url_or_id.rstrip("/").split("?")[0]
        return clean.split("/")[-1]
    return url_or_id.strip()


def _list_files(service, folder_id: str, parent_name: str = "") -> list[dict]:
    """
    Recursively list all image/RAW files in a Drive folder.
    Returns list of dicts with id, name, mimeType, parent_folder_name.
    """
    files = []
    page_token = None

    while True:
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed=false",
            spaces="drive",
            fields="nextPageToken, files(id, name, mimeType)",
            pageToken=page_token,
            pageSize=1000,
        ).execute()

        for f in resp.get("files", []):
            mime = f.get("mimeType", "")
            name = f.get("name", "")

            if mime == "application/vnd.google-apps.folder":
                # Recurse — folder name becomes parent hint (camera owner)
                files.extend(_list_files(service, f["id"], parent_name=name))
            elif is_supported_file(name):
                f["parent_folder_name"] = parent_name
                files.append(f)

        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return files


def _download_file(service, file_id: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = service.files().get_media(fileId=file_id)
    with open(dest, "wb") as fh:
        dl = MediaIoBaseDownload(fh, request)
        done = False
        while not done:
            _, done = dl.next_chunk()


# ── Main ingestion task ────────────────────────────────────────────────────────

def run_ingestion(trip_id: str) -> None:
    """
    Full ingestion pipeline for a trip. Runs synchronously in a background thread.
    Progress is written to _progress[trip_id] and readable via get_progress().
    """
    from drive.auth import get_drive_service

    session = SessionLocal()

    try:
        trip = crud.get_trip(session, trip_id)
        if not trip:
            _update(trip_id, status="error", error="Trip not found")
            return

        crud.update_trip_status(session, trip_id, "ingesting")
        _update(trip_id, status="listing", total_files=0, downloaded=0, processed=0,
                raw_count=0, video_count=0, duplicate_count=0)

        # Step 1 — Authenticate + list all files
        service = get_drive_service()
        all_files = _list_files(service, trip.drive_folder_id)
        total = len(all_files)
        _update(trip_id, status="downloading", total_files=total)

        trip_temp = TEMP_DIR / trip_id
        trip_temp.mkdir(parents=True, exist_ok=True)

        raw_count = 0
        video_count = 0
        duplicate_count = 0

        for idx, f in enumerate(all_files):
            file_id = f["id"]
            file_name = f["name"]
            parent_folder = f.get("parent_folder_name", "")
            file_type = get_file_type(Path(file_name))
            is_raw = file_type == "raw"
            is_video = file_type == "video"
            skip_image_processing = is_raw or is_video

            # Determine download destination — raw/video get their own sub-folders
            if is_raw:
                dest = trip_temp / "raw" / file_name
            elif is_video:
                dest = trip_temp / "videos" / file_name
            else:
                dest = trip_temp / file_name

            # Download
            _download_file(service, file_id, dest)
            _update(trip_id, downloaded=idx + 1)

            # pHash and duplicate check only for regular images
            phash = None if skip_image_processing else compute_phash(dest)
            is_duplicate = False
            duplicate_of_id = None
            if phash:
                existing = crud.find_duplicate(session, trip_id, phash)
                if existing:
                    is_duplicate = True
                    duplicate_of_id = existing.id
                    duplicate_count += 1

            # EXIF only for regular images
            exif_dt, exif_device = (None, None) if skip_image_processing else extract_exif(dest)

            photo = Photo(
                id=str(uuid.uuid4()),
                trip_id=trip_id,
                drive_file_id=file_id,
                drive_file_name=file_name,
                drive_parent_folder=parent_folder,
                local_path=str(dest),
                file_type=file_type,
                is_raw=is_raw,
                is_video=is_video,
                is_duplicate=is_duplicate,
                duplicate_of_id=duplicate_of_id,
                perceptual_hash=phash,
                exif_timestamp=exif_dt,
                exif_device=exif_device,
            )
            crud.create_photo(session, photo)

            if is_raw:
                raw_count += 1
            elif is_video:
                video_count += 1

            _update(trip_id,
                    status="processing",
                    processed=idx + 1,
                    raw_count=raw_count,
                    video_count=video_count,
                    duplicate_count=duplicate_count)

        crud.update_trip_status(session, trip_id, "ingested")
        _update(trip_id,
                status="done",
                total_files=total,
                processed=total,
                raw_count=raw_count,
                video_count=video_count,
                duplicate_count=duplicate_count)

    except Exception as e:
        crud.fail_trip(session, trip_id, str(e))
        _update(trip_id, status="error", error=str(e))
        raise
    finally:
        session.close()


def start_ingestion_thread(trip_id: str) -> None:
    """Kick off ingestion in a daemon thread so the API returns immediately."""
    thread = threading.Thread(target=run_ingestion, args=(trip_id,), daemon=True)
    thread.start()
