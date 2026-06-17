"""
Phase 3 smoke test — classification + Drive upload.

Run from backend/ with the venv active:
    python ../tests/test_phase3.py

Prerequisites: trip must be in 'enrolled' status with all faces named.
Re-enrollment is done automatically if trip is already 'classified' or 'uploaded'
(the test resets to enrolled first to exercise the full pipeline).
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from database.models import SessionLocal, Trip, Photo, FaceObservation, Person, PersonEmbedding, TripPerson
from pipeline.classify import _run_classify

TRIP_ID = "11dcb4d4-b24c-4466-b19a-f01eb6156980"
PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"

errors = []

def check(label, condition, detail=""):
    if condition:
        print(f"  {PASS} {label}")
    else:
        print(f"  {FAIL} {label}{': ' + detail if detail else ''}")
        errors.append(label)


def reset_to_enrolled(session):
    """Reset trip to enrolled state so we can re-run classification."""
    session.query(Trip).filter(Trip.id == TRIP_ID).update({"status": "enrolled"})
    session.query(Photo).filter(Photo.trip_id == TRIP_ID).update({"scene_label": None})
    session.commit()
    session.expire_all()


# ── Setup ──────────────────────────────────────────────────────────────────────

session = SessionLocal()
trip = session.query(Trip).filter(Trip.id == TRIP_ID).first()

if not trip:
    print(f"{FAIL} Trip {TRIP_ID} not found")
    sys.exit(1)

print(f"\nTrip: {trip.name!r} (status={trip.status})")

if trip.status not in ("enrolled", "classified", "uploaded", "failed"):
    print(f"{FAIL} Trip must be at least 'enrolled' to run Phase 3 tests")
    sys.exit(1)

reset_to_enrolled(session)
trip = session.query(Trip).filter(Trip.id == TRIP_ID).first()
print(f"Reset to enrolled. Running classification pipeline...\n")

# ── Run classification ─────────────────────────────────────────────────────────

t0 = time.time()
_run_classify(TRIP_ID)
elapsed = time.time() - t0
session.expire_all()

# ── 1. Trip status ─────────────────────────────────────────────────────────────

print("1. Trip status")
trip = session.query(Trip).filter(Trip.id == TRIP_ID).first()
check("status = 'classified'", trip.status == "classified", f"got '{trip.status}'")
check(f"classification completed in <120s", elapsed < 120, f"{elapsed:.1f}s")

# ── 2. Face matching (FAISS) ───────────────────────────────────────────────────

print("\n2. FAISS face matching")
all_faces = (
    session.query(FaceObservation)
    .join(Photo, Photo.id == FaceObservation.photo_id)
    .filter(Photo.trip_id == TRIP_ID)
    .all()
)
named = [f for f in all_faces if f.person_id]
strangers = [f for f in all_faces if f.is_stranger]
unassigned = [f for f in all_faces if not f.person_id and not f.is_stranger]

check(f"total faces = 90", len(all_faces) == 90, f"got {len(all_faces)}")
check(f"named faces = 83", len(named) == 83, f"got {len(named)}")
check(f"strangers = 7", len(strangers) == 7, f"got {len(strangers)}")
check(f"unassigned = 0", len(unassigned) == 0, f"got {len(unassigned)} — FAISS failed to assign some faces")

# ── 3. Scene classification ────────────────────────────────────────────────────

print("\n3. Scene classification (OpenCLIP)")
no_face_photos = (
    session.query(Photo)
    .filter(
        Photo.trip_id == TRIP_ID,
        Photo.face_count == 0,
        Photo.is_raw == False,
        Photo.is_video == False,
        Photo.is_duplicate == False,
    )
    .all()
)

labeled = [p for p in no_face_photos if p.scene_label]
valid_labels = {"beach", "mountain", "temple", "monument", "street", "market", "nature", "indoor", "food", "other"}
invalid = [p for p in labeled if p.scene_label not in valid_labels]

check(f"no-face photos = 12", len(no_face_photos) == 12, f"got {len(no_face_photos)}")
check(f"all 12 have scene_label", len(labeled) == 12, f"only {len(labeled)} labeled")
check(f"all labels are valid", len(invalid) == 0, f"invalid: {[p.scene_label for p in invalid]}")

from collections import Counter
label_counts = Counter(p.scene_label for p in labeled)
print(f"     Scene breakdown: {dict(label_counts)}")

# ── 4. PersonEmbeddings integrity ─────────────────────────────────────────────

print("\n4. Registry integrity")
persons = (
    session.query(Person)
    .join(TripPerson, TripPerson.person_id == Person.id)
    .filter(TripPerson.trip_id == TRIP_ID)
    .all()
)
check("9 persons enrolled", len(persons) == 9, f"got {len(persons)}")

import numpy as np
total_embs = 0
norm_ok = True
for person in persons:
    embs = session.query(PersonEmbedding).filter(PersonEmbedding.person_id == person.id).all()
    total_embs += len(embs)
    for e in embs:
        arr = np.frombuffer(e.embedding, dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        if abs(norm - 1.0) > 0.01:
            norm_ok = False
            print(f"     BAD norm: {person.name} emb {e.id}: norm={norm:.4f}")

check("83 PersonEmbeddings stored", total_embs == 83, f"got {total_embs}")
check("all embeddings L2-normalized (norm=1.0 ±0.01)", norm_ok)
check("all persons have thumbnails", all(p.thumbnail for p in persons))

# ── 5. Photo routing logic ─────────────────────────────────────────────────────

print("\n5. Photo routing (verify shortcuts would be correct)")
face_photos = [p for p in session.query(Photo).filter(Photo.trip_id == TRIP_ID).all() if p.face_count > 0 and not p.is_duplicate]

photos_with_named_faces = 0
photos_with_only_strangers = 0
photos_with_unmatched = 0

for photo in face_photos:
    faces = session.query(FaceObservation).filter(FaceObservation.photo_id == photo.id).all()
    named_pids = {f.person_id for f in faces if f.person_id}
    has_unmatched = any(not f.person_id and not f.is_stranger for f in faces)
    only_strangers = not named_pids and not has_unmatched

    if named_pids:
        photos_with_named_faces += 1
    if only_strangers:
        photos_with_only_strangers += 1
    if has_unmatched:
        photos_with_unmatched += 1

check("0 photos with unmatched faces (Misc)", photos_with_unmatched == 0, f"got {photos_with_unmatched}")
# Stranger-only photos are intentionally skipped in Drive output — not a bug.
# They hold faces of random passers-by who were dismissed during enrollment.
print(f"     Face photos: {len(face_photos)} | with named: {photos_with_named_faces} | stranger-only (excluded): {photos_with_only_strangers}")
check("stranger-only photos ≤ dismissed strangers count (7)", photos_with_only_strangers <= 7,
      f"got {photos_with_only_strangers}")

# ── 6. API results endpoint ────────────────────────────────────────────────────

print("\n6. /api/classify/{id}/results response shape")
import urllib.request
try:
    with urllib.request.urlopen(f"http://localhost:8000/api/classify/{TRIP_ID}/results") as resp:
        data = json.loads(resp.read())
    check("persons list present", "persons" in data)
    check("9 persons in results", len(data["persons"]) == 9, f"got {len(data['persons'])}")
    check("scene_counts present", "scene_counts" in data)
    check("misc_count = 0", data["misc_count"] == 0, f"got {data['misc_count']}")
    total_person_photos = sum(p["photo_count"] for p in data["persons"])
    check("person photo_counts > 0", all(p["photo_count"] > 0 for p in data["persons"]))
    print(f"     Total person-photo assignments: {total_person_photos} (photos appear in multiple people's folders)")
except Exception as e:
    check("API results reachable", False, str(e))

# ── Summary ────────────────────────────────────────────────────────────────────

print(f"\n{'─'*50}")
if errors:
    print(f"\033[31m{len(errors)} FAILED:\033[0m")
    for e in errors:
        print(f"  • {e}")
    sys.exit(1)
else:
    print(f"\033[32mAll Phase 3 checks passed\033[0m ({elapsed:.1f}s classification time)")

session.close()
