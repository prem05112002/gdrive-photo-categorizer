#!/usr/bin/env python3
"""
Phase 1 smoke test — face detection pipeline.

Usage:
    source backend/.venv/bin/activate

    # Use an already-ingested trip:
    python tests/test_phase1.py --trip-id <id>

    # Or ingest + extract in one shot:
    python tests/test_phase1.py --drive-url "https://drive.google.com/drive/folders/..."
"""

import sys
import time
import uuid
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import numpy as np
from database.models import init_db, SessionLocal, Trip, FaceObservation, Photo
from database import crud
from drive.ingest import run_ingestion, extract_folder_id
from pipeline.face import run_face_pipeline


def sep(title: str = "") -> None:
    w = 52
    if title:
        pad = (w - len(title) - 2) // 2
        print(f"\n{'─' * pad} {title} {'─' * pad}")
    else:
        print("─" * w)


def main() -> None:
    parser = argparse.ArgumentParser()
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--trip-id",   help="ID of an already-ingested trip")
    grp.add_argument("--drive-url", help="Run fresh ingestion + face pipeline")
    args = parser.parse_args()

    print("\n◆ Photo Categorizer — Phase 1 Smoke Test")
    sep()

    init_db()
    session = SessionLocal()

    try:
        # ── Optionally ingest first ────────────────────────────────────────────
        if args.drive_url:
            folder_id = extract_folder_id(args.drive_url)
            trip_id = str(uuid.uuid4())
            trip = Trip(id=trip_id, name="Phase 1 Test", drive_folder_id=folder_id)
            crud.create_trip(session, trip)
            print(f"  Ingesting {folder_id}…")
            run_ingestion(trip_id)
            session.expire_all()
        else:
            trip_id = args.trip_id

        trip = crud.get_trip(session, trip_id)
        if not trip:
            print(f"✗  Trip {trip_id} not found"); sys.exit(1)
        if trip.status not in ("ingested", "faces_extracted", "extracting_faces", "failed"):
            print(f"✗  Trip must be at least 'ingested', got '{trip.status}'"); sys.exit(1)
        # Allow re-running on a stuck/previously-failed trip by resetting status
        if trip.status in ("extracting_faces", "failed"):
            crud.update_trip_status(session, trip_id, "ingested")
            session.expire_all()

        print(f"  Trip : {trip.name}")
        print(f"  ID   : {trip_id}")

        # ── Run face pipeline ──────────────────────────────────────────────────
        sep("Face Pipeline")
        print("  Model downloads ~235 MB on first run — subsequent runs are instant.\n")

        t0 = time.time()
        run_face_pipeline(trip_id)
        elapsed = time.time() - t0

        # ── Results ────────────────────────────────────────────────────────────
        sep("Results")
        session.expire_all()
        stats  = crud.get_face_stats(session, trip_id)
        counts = crud.get_trip_photo_counts(session, trip_id)
        images = counts["photo_count"] - counts["raw_count"] - counts["video_count"] - counts["duplicate_count"]

        print(f"  Time             : {elapsed:.1f}s")
        print(f"  Images processed : {images}")
        print(f"  Faces detected   : {stats['total_faces']}")
        print(f"  Photos with faces: {stats['photos_with_faces']}")
        print(f"  Group candidates : {stats['group_photo_candidates']}  (≥5 faces)")
        if images > 0 and elapsed > 0:
            print(f"  Throughput       : {images / elapsed:.1f} photos/sec")

        # ── Per-photo breakdown ────────────────────────────────────────────────
        sep("Photos by face count (top 15)")
        photos = sorted(
            [p for p in crud.get_photos_by_trip(session, trip_id)
             if not p.is_raw and not p.is_video and not p.is_duplicate],
            key=lambda p: -(p.face_count or 0)
        )
        for p in photos[:15]:
            flag = "  ◈ GROUP CANDIDATE" if p.is_group_photo else ""
            print(f"  {p.face_count:>3} face(s)  {p.drive_file_name}{flag}")
        if len(photos) > 15:
            print(f"  … and {len(photos) - 15} more")

        # ── Embedding sanity check ─────────────────────────────────────────────
        sep("Checks")
        sample_obs = (
            session.query(FaceObservation)
            .join(Photo, Photo.id == FaceObservation.photo_id)
            .filter(Photo.trip_id == trip_id, FaceObservation.raw_embedding.isnot(None))
            .first()
        )
        embedding_ok = False
        if sample_obs and sample_obs.raw_embedding:
            arr = np.frombuffer(sample_obs.raw_embedding, dtype=np.float32)
            embedding_ok = arr.shape == (512,)

        crop_ok = (
            session.query(FaceObservation)
            .join(Photo, Photo.id == FaceObservation.photo_id)
            .filter(Photo.trip_id == trip_id, FaceObservation.face_crop.isnot(None))
            .first()
        ) is not None

        trip_after = crud.get_trip(session, trip_id)
        checks = [
            ("Trip status is 'faces_extracted'",  trip_after.status == "faces_extracted"),
            ("At least one face detected",         stats["total_faces"] > 0),
            ("Embeddings are 512-dim float32",     embedding_ok),
            ("Face crops stored as JPEG bytes",    crop_ok),
            ("Confidence scores in range (0–1)",   _check_confidences(session, trip_id)),
        ]

        all_passed = True
        for label, result in checks:
            print(f"  {'✓' if result else '✗'}  {label}")
            if not result:
                all_passed = False

        sep()
        if all_passed:
            print("  All checks passed. Phase 1 is working correctly.\n")
        else:
            print("  Some checks failed — see above.\n")
            sys.exit(1)

    except KeyboardInterrupt:
        print("\n  Interrupted.")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback; traceback.print_exc()
        sys.exit(1)
    finally:
        session.close()


def _check_confidences(session, trip_id: str) -> bool:
    obs_list = (
        session.query(FaceObservation)
        .join(Photo, Photo.id == FaceObservation.photo_id)
        .filter(Photo.trip_id == trip_id)
        .limit(20)
        .all()
    )
    if not obs_list:
        return False
    return all(0.0 <= (o.confidence or 0) <= 1.0 for o in obs_list)


if __name__ == "__main__":
    main()
