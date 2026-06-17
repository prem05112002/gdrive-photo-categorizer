#!/usr/bin/env python3
"""
Phase 0 smoke test — ingestion pipeline.

Usage (run from project root):
    source backend/.venv/bin/activate
    python tests/test_phase0.py --drive-url "https://drive.google.com/drive/folders/..."

A browser tab will open on first run for Google OAuth. After approving,
token.json is saved and reused on every subsequent run.
"""

import sys
import uuid
import argparse
from pathlib import Path

# Make backend importable from project root
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from database.models import init_db, SessionLocal, Trip
from database import crud
from drive.ingest import run_ingestion, extract_folder_id, get_progress


def separator(title: str = "") -> None:
    width = 50
    if title:
        pad = (width - len(title) - 2) // 2
        print(f"\n{'─' * pad} {title} {'─' * pad}")
    else:
        print("─" * width)


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 0 smoke test")
    parser.add_argument("--drive-url", required=True, help="Shared Google Drive folder URL")
    parser.add_argument("--trip-name", default="Phase 0 Test", help="Name for the test trip")
    args = parser.parse_args()

    print("\n◆ Photo Categorizer — Phase 0 Smoke Test")
    separator()

    # ── Setup ──────────────────────────────────────────────────────────────────
    init_db()
    session = SessionLocal()

    try:
        folder_id = extract_folder_id(args.drive_url)
        trip_id = str(uuid.uuid4())

        trip = Trip(
            id=trip_id,
            name=args.trip_name,
            drive_folder_id=folder_id,
        )
        crud.create_trip(session, trip)
        print(f"  Trip created : {args.trip_name}")
        print(f"  Folder ID   : {folder_id}")
        print(f"  Trip ID     : {trip_id}")

        # ── Ingestion ──────────────────────────────────────────────────────────
        separator("Ingestion")
        print("  A browser tab may open for Google OAuth on first run.")
        print("  Approve access, then come back here.\n")

        run_ingestion(trip_id)          # blocking — runs in this thread

        progress = get_progress(trip_id)
        if progress.get("status") == "error":
            print(f"\n✗ Ingestion failed: {progress.get('error')}")
            sys.exit(1)

        # ── Results ────────────────────────────────────────────────────────────
        separator("Results")
        session.expire_all()  # flush identity map so we read the committed state from run_ingestion
        trip_after = crud.get_trip(session, trip_id)
        counts = crud.get_trip_photo_counts(session, trip_id)

        image_count = (
            counts["photo_count"]
            - counts["raw_count"]
            - counts["video_count"]
            - counts["duplicate_count"]
        )

        print(f"  Status          : {trip_after.status}")
        print(f"  Total files     : {counts['photo_count']}")
        print(f"  Images          : {image_count}")
        print(f"  RAW             : {counts['raw_count']}")
        print(f"  Videos          : {counts['video_count']}")
        print(f"  Duplicates skip : {counts['duplicate_count']}")

        # ── Sample file listing ────────────────────────────────────────────────
        separator("Sample files (first 15)")
        photos = crud.get_photos_by_trip(session, trip_id)
        for p in photos[:15]:
            flags = []
            if p.is_raw:       flags.append("RAW")
            if p.is_video:     flags.append("VIDEO")
            if p.is_duplicate: flags.append("DUPE")
            tag     = f"  [{', '.join(flags)}]" if flags else ""
            device  = f"  ← {p.exif_device}" if p.exif_device else ""
            ts      = f"  {p.exif_timestamp.strftime('%Y-%m-%d')}" if p.exif_timestamp else ""
            print(f"  {p.drive_file_name}{tag}{ts}{device}")

        if len(photos) > 15:
            print(f"  … and {len(photos) - 15} more")

        # ── Assertions ─────────────────────────────────────────────────────────
        separator("Checks")
        checks = [
            ("Trip status is 'ingested'",       trip_after.status == "ingested"),
            ("At least one file ingested",       counts["photo_count"] > 0),
            ("No error in progress state",       progress.get("status") != "error"),
            ("Processed count matches total",    progress.get("processed") == progress.get("total_files")),
        ]

        all_passed = True
        for label, result in checks:
            icon = "✓" if result else "✗"
            print(f"  {icon}  {label}")
            if not result:
                all_passed = False

        separator()
        if all_passed:
            print("  All checks passed. Phase 0 is working correctly.\n")
        else:
            print("  Some checks failed — see above.\n")
            sys.exit(1)

    except KeyboardInterrupt:
        print("\n  Interrupted.")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        session.close()


if __name__ == "__main__":
    main()
