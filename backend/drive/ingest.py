import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from googleapiclient.http import MediaIoBaseDownload

from database.models import SessionLocal, Photo
from database import crud
from utils.image import get_file_type, is_supported_file, phash_and_exif

TEMP_DIR = Path(__file__).parent.parent / "temp"

DOWNLOAD_WORKERS = 12   # Drive per-user quota (~12k req/min) tolerates far more
COMMIT_BATCH = 50       # SQLite fsyncs per commit — batch rows to avoid 1 fsync/photo


# ── Progress tracking (in-memory, single-user tool) ───────────────────────────

_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()


def get_progress(trip_id: str) -> dict:
    return _progress.get(trip_id, {})


def _update(trip_id: str, **kwargs) -> None:
    with _progress_lock:
        if trip_id not in _progress:
            _progress[trip_id] = {}
        _progress[trip_id].update(kwargs)


def _bump(trip_id: str, key: str) -> None:
    with _progress_lock:
        d = _progress.setdefault(trip_id, {})
        d[key] = d.get(key, 0) + 1


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
    Returns list of dicts with id, name, mimeType, md5Checksum, size, parent_folder_name.
    """
    files = []
    page_token = None

    while True:
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed=false",
            spaces="drive",
            fields="nextPageToken, files(id, name, mimeType, md5Checksum, size)",
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


# googleapiclient service objects are not thread-safe — one per worker thread.
_tls = threading.local()


def _thread_service():
    from drive.auth import get_drive_service
    if getattr(_tls, "service", None) is None:
        _tls.service = get_drive_service()
    return _tls.service


def _dest_for(f: dict, trip_temp: Path) -> Path:
    """Unique local path for a Drive file. The file-id prefix prevents collisions
    when different camera sub-folders contain the same filename (IMG_0001.JPG)."""
    file_name = f["name"]
    file_type = get_file_type(Path(file_name))
    unique_name = f"{f['id']}__{file_name}"
    if file_type == "raw":
        return trip_temp / "raw" / unique_name
    if file_type == "video":
        return trip_temp / "videos" / unique_name
    return trip_temp / unique_name


def _fetch_one(trip_id: str, f: dict, trip_temp: Path) -> dict:
    """
    Worker: download one file (skips if already cached with matching size),
    then compute pHash + EXIF for regular images. No DB access here.
    """
    file_name = f["name"]
    file_type = get_file_type(Path(file_name))
    skip_image_processing = file_type in ("raw", "video")
    dest = _dest_for(f, trip_temp)

    expected_size = int(f["size"]) if f.get("size") else None
    if not (dest.exists() and expected_size is not None and dest.stat().st_size == expected_size):
        _download_file(_thread_service(), f["id"], dest)

    _bump(trip_id, "downloaded")

    phash, exif_dt, exif_device = (None, None, None)
    if not skip_image_processing:
        phash, exif_dt, exif_device = phash_and_exif(dest)

    return {
        "file": f,
        "dest": dest,
        "file_type": file_type,
        "phash": phash,
        "exif_dt": exif_dt,
        "exif_device": exif_device,
    }


# ── Main ingestion task ────────────────────────────────────────────────────────

def run_ingestion(trip_id: str) -> None:
    """
    Full ingestion pipeline for a trip. Runs synchronously in a background thread.
    Progress is written to _progress[trip_id] and readable via get_progress().

    Downloads run in parallel; DB writes happen only on this thread, committed in
    batches. Exact duplicates (same Drive md5Checksum) are detected *before*
    download and never fetched. Already-ingested files (re-run after a crash)
    are skipped entirely.
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
                raw_count=0, video_count=0, duplicate_count=0, failed_count=0)

        # Step 1 — Authenticate + list all files
        service = get_drive_service()
        all_files = _list_files(service, trip.drive_folder_id)
        total = len(all_files)

        trip_temp = TEMP_DIR / trip_id
        trip_temp.mkdir(parents=True, exist_ok=True)

        # Step 2 — Re-ingestion guard: skip files already ingested for this trip
        existing = {p.drive_file_id: p for p in crud.get_photos_by_trip(session, trip_id)}
        raw_count = sum(1 for p in existing.values() if p.is_raw)
        video_count = sum(1 for p in existing.values() if p.is_video)
        duplicate_count = sum(1 for p in existing.values() if p.is_duplicate)
        failed_count = 0

        # Seed dedupe maps from existing rows (md5 = exact, phash = near-dup)
        md5_to_photo: dict[str, str] = {
            p.md5_checksum: p.id for p in existing.values()
            if p.md5_checksum and not p.is_duplicate
        }
        phash_to_photo: dict[str, str] = {
            p.perceptual_hash: p.id for p in existing.values()
            if p.perceptual_hash and not p.is_duplicate
        }

        pending: list[dict] = []
        skipped_existing = 0
        for f in all_files:
            prev = existing.get(f["id"])
            if prev and (prev.is_duplicate or (prev.local_path and Path(prev.local_path).exists())):
                skipped_existing += 1
                continue
            pending.append(f)

        # Step 3 — Exact-duplicate pre-pass: same md5 → never downloaded
        canonicals: list[dict] = []
        md5_dups: list[tuple[dict, str, str]] = []   # (file, ref_kind, ref) — ref is photo.id or drive_file_id
        listing_md5: dict[str, str] = {}             # md5 → canonical drive_file_id in this listing
        for f in pending:
            md5 = f.get("md5Checksum")
            if md5 and md5 in md5_to_photo:
                md5_dups.append((f, "photo", md5_to_photo[md5]))    # dup of an existing photo row
            elif md5 and md5 in listing_md5:
                md5_dups.append((f, "drive", listing_md5[md5]))     # dup within this listing
            else:
                if md5:
                    listing_md5[md5] = f["id"]
                canonicals.append(f)

        _update(trip_id, status="downloading", total_files=total,
                downloaded=skipped_existing, processed=skipped_existing,
                raw_count=raw_count, video_count=video_count,
                duplicate_count=duplicate_count)

        # Step 4 — Parallel download + hash of canonical files; DB writes here only
        drive_to_photo: dict[str, str] = {}   # drive_file_id → photo.id (this run)
        processed = skipped_existing
        uncommitted = 0

        def _flush():
            nonlocal uncommitted
            if uncommitted:
                session.commit()
                uncommitted = 0

        with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
            futures = {pool.submit(_fetch_one, trip_id, f, trip_temp): f for f in canonicals}
            for fut in as_completed(futures):
                f = futures[fut]
                try:
                    res = fut.result()
                except Exception as e:
                    failed_count += 1
                    processed += 1
                    _update(trip_id, processed=processed, failed_count=failed_count,
                            last_error=f"{f['name']}: {e}")
                    continue

                file_type = res["file_type"]
                is_raw = file_type == "raw"
                is_video = file_type == "video"

                # Near-duplicate check (pHash) — images only, single-threaded here
                phash = res["phash"]
                is_duplicate = False
                duplicate_of_id = None
                if phash and phash in phash_to_photo:
                    is_duplicate = True
                    duplicate_of_id = phash_to_photo[phash]
                    duplicate_count += 1

                photo = Photo(
                    id=str(uuid.uuid4()),
                    trip_id=trip_id,
                    drive_file_id=f["id"],
                    drive_file_name=f["name"],
                    drive_parent_folder=f.get("parent_folder_name", ""),
                    local_path=str(res["dest"]),
                    file_type=file_type,
                    is_raw=is_raw,
                    is_video=is_video,
                    is_duplicate=is_duplicate,
                    duplicate_of_id=duplicate_of_id,
                    perceptual_hash=phash,
                    md5_checksum=f.get("md5Checksum"),
                    exif_timestamp=res["exif_dt"],
                    exif_device=res["exif_device"],
                )
                session.add(photo)
                uncommitted += 1

                drive_to_photo[f["id"]] = photo.id
                if phash and not is_duplicate:
                    phash_to_photo[phash] = photo.id

                if is_raw:
                    raw_count += 1
                elif is_video:
                    video_count += 1

                processed += 1
                if uncommitted >= COMMIT_BATCH:
                    _flush()
                _update(trip_id, processed=processed,
                        raw_count=raw_count, video_count=video_count,
                        duplicate_count=duplicate_count, failed_count=failed_count)

        _flush()

        # Step 5 — Insert exact-duplicate rows (no local file, never downloaded)
        for f, ref_kind, ref in md5_dups:
            # ref is a photo.id directly, or a drive_file_id whose photo row was
            # created this run (None if the canonical download failed).
            duplicate_of_id = ref if ref_kind == "photo" else drive_to_photo.get(ref)
            file_type = get_file_type(Path(f["name"]))
            session.add(Photo(
                id=str(uuid.uuid4()),
                trip_id=trip_id,
                drive_file_id=f["id"],
                drive_file_name=f["name"],
                drive_parent_folder=f.get("parent_folder_name", ""),
                local_path=None,
                file_type=file_type,
                is_raw=file_type == "raw",
                is_video=file_type == "video",
                is_duplicate=True,
                duplicate_of_id=duplicate_of_id,
                md5_checksum=f.get("md5Checksum"),
            ))
            duplicate_count += 1
            processed += 1
        session.commit()

        crud.update_trip_status(session, trip_id, "ingested")
        _update(trip_id,
                status="done",
                total_files=total,
                downloaded=total,
                processed=total,
                raw_count=raw_count,
                video_count=video_count,
                duplicate_count=duplicate_count,
                failed_count=failed_count)

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
