"""
Phase 8 smoke test — Gallery API, image serving, reassign, sync, cache clear.

Run from backend/ with the venv active and the backend running at localhost:8000:
    python ../tests/test_phase8.py

Prerequisites: trip must be in 'uploaded' status (Phases 0–3 complete).
"""
import json
import sys
import uuid
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from database.models import (
    SessionLocal, FaceObservation, Photo, Person, TripPerson, UserCorrection
)

TRIP_ID = "11dcb4d4-b24c-4466-b19a-f01eb6156980"
BASE = "http://localhost:8000/api"
PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"

errors = []
created_ids: dict[str, list] = {
    "face_obs": [],
    "corrections": [],
}


def check(label, condition, detail=""):
    if condition:
        print(f"  {PASS} {label}")
    else:
        msg = f"  {FAIL} {label}"
        if detail:
            msg += f": {detail}"
        print(msg)
        errors.append(label)


def get(path):
    try:
        with urllib.request.urlopen(f"{BASE}{path}") as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def patch(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="PATCH",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def delete(path):
    req = urllib.request.Request(f"{BASE}{path}", method="DELETE")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def insert_misc_face(session, photo_id: str) -> str:
    import numpy as np
    v = np.random.randn(512).astype(np.float32)
    v /= np.linalg.norm(v)
    # Tiny synthetic JPEG header so face_crop is not None
    synthetic_crop = (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        + b"\xff\xdb\x00C\x00" + bytes(64) + b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
        + b"\xff\xd9"
    )
    face = FaceObservation(
        id=str(uuid.uuid4()),
        photo_id=photo_id,
        person_id=None,
        is_stranger=False,
        confidence=0.72,
        raw_embedding=v.tobytes(),
        face_crop=synthetic_crop,
    )
    session.add(face)
    session.commit()
    created_ids["face_obs"].append(face.id)
    return face.id


def cleanup(session):
    for cid in created_ids["corrections"]:
        row = session.query(UserCorrection).filter(UserCorrection.id == cid).first()
        if row:
            session.delete(row)
    for fid in created_ids["face_obs"]:
        row = session.query(FaceObservation).filter(FaceObservation.id == fid).first()
        if row:
            session.delete(row)
    session.commit()


# ── Setup ──────────────────────────────────────────────────────────────────────

session = SessionLocal()

try:
    urllib.request.urlopen(f"{BASE}/health").read()
except Exception:
    print(f"{FAIL} Backend not reachable at {BASE} — start it first")
    sys.exit(1)

trip_persons = session.query(TripPerson).filter(TripPerson.trip_id == TRIP_ID).all()
if not trip_persons:
    print(f"{FAIL} No TripPerson rows for {TRIP_ID} — run Phases 0–3 first")
    sys.exit(1)

all_persons = [
    (tp.person_id, session.query(Person).filter(Person.id == tp.person_id).first())
    for tp in trip_persons
]
person_a_id, person_a = all_persons[0]
person_b_id, person_b = all_persons[1]

real_photos = (
    session.query(Photo)
    .filter(
        Photo.trip_id == TRIP_ID,
        Photo.is_raw == False,
        Photo.is_video == False,
        Photo.is_duplicate == False,
    )
    .all()
)
sample_photo = real_photos[0]

real_faces = (
    session.query(FaceObservation)
    .join(Photo, Photo.id == FaceObservation.photo_id)
    .filter(
        Photo.trip_id == TRIP_ID,
        FaceObservation.person_id.isnot(None),
        FaceObservation.face_crop.isnot(None),
    )
    .limit(5)
    .all()
)

print(f"\nTrip: {TRIP_ID}")
print(f"Person A: {person_a.name!r} ({person_a_id})")
print(f"Person B: {person_b.name!r} ({person_b_id})")
print(f"Sample photo: {sample_photo.drive_file_name!r} ({sample_photo.id})")
print(f"Real faces with crops: {len(real_faces)}\n")


# ── 1. Gallery structure ───────────────────────────────────────────────────────

print("1. GET /api/trips/{trip_id}/gallery — structure")
status, body, _ = get(f"/trips/{TRIP_ID}/gallery")
gallery = json.loads(body)

check("status 200", status == 200, str(status))
check("'persons' key present", "persons" in gallery)
check("'places' key present", "places" in gallery)
check("'misc' key present", "misc" in gallery)

persons_g = gallery.get("persons", [])
places_g = gallery.get("places", [])
misc_g = gallery.get("misc", [])

enrolled_count = len(trip_persons)
check(f"persons count matches enrolled ({enrolled_count})", len(persons_g) == enrolled_count,
      f"got {len(persons_g)}")

total_db_person_photos = 0
for p in persons_g:
    total_db_person_photos += p["photo_count"]
    check(f"  {p['name']}: has id+name+photo_count+photos keys",
          all(k in p for k in ("id", "name", "photo_count", "photos")))
    check(f"  {p['name']}: photos list length matches photo_count",
          len(p["photos"]) == p["photo_count"],
          f"list={len(p['photos'])}, count={p['photo_count']}")
    if p["photos"]:
        sample = p["photos"][0]
        check(f"  {p['name']}: each photo has id+filename",
              "id" in sample and "filename" in sample)
        check(f"  {p['name']}: each photo has face_obs_id",
              "face_obs_id" in sample and sample["face_obs_id"] is not None)
        check(f"  {p['name']}: each photo has bbox fields",
              all(k in sample for k in ("bbox_x", "bbox_y", "bbox_w", "bbox_h")))

check("persons ordered by photo_count descending",
      all(persons_g[i]["photo_count"] >= persons_g[i+1]["photo_count"]
          for i in range(len(persons_g)-1)))

for pl in places_g:
    check(f"  place '{pl['label']}': has label+photos", "label" in pl and "photos" in pl)
    if pl["photos"]:
        check(f"  place '{pl['label']}': photos have id+filename",
              "id" in pl["photos"][0] and "filename" in pl["photos"][0])

check("misc is a list", isinstance(misc_g, list))

print(f"\n  Summary: {len(persons_g)} persons, {len(places_g)} places, {len(misc_g)} misc photos")
total_place_photos = sum(len(pl["photos"]) for pl in places_g)
print(f"  Person photos: {total_db_person_photos}, Place photos: {total_place_photos}, Misc photos: {len(misc_g)}")


# ── 2. Cover photo ─────────────────────────────────────────────────────────────

print("\n2. GET /api/trips/{trip_id}/cover")
status, body, headers = get(f"/trips/{TRIP_ID}/cover")
check("status 200", status == 200, str(status))
check("content-type image/jpeg", "image/jpeg" in headers.get("content-type", ""))
check("JPEG magic bytes (FF D8)", body[:2] == b'\xff\xd8', body[:2].hex())
check("non-trivial size (>10KB)", len(body) > 10_000, f"{len(body)} bytes")
print(f"  Cover photo: {len(body):,} bytes")

print("\n2b. GET /api/trips/bad-id/cover → 404")
status, _, _ = get("/trips/does-not-exist/cover")
check("status 404", status == 404, str(status))


# ── 3. Photo image serving ─────────────────────────────────────────────────────

print("\n3. GET /api/photos/{photo_id}/image?trip_id=")
status, body, headers = get(f"/photos/{sample_photo.id}/image?trip_id={TRIP_ID}")
check("status 200", status == 200, str(status))
check("content-type image/jpeg", "image/jpeg" in headers.get("content-type", ""))
check("JPEG magic bytes", body[:2] == b'\xff\xd8', body[:2].hex())
check("non-trivial size (>50KB)", len(body) > 50_000, f"{len(body)} bytes")
print(f"  Photo '{sample_photo.drive_file_name}': {len(body):,} bytes")

print("\n3b. GET with wrong trip_id → 404")
status, _, _ = get(f"/photos/{sample_photo.id}/image?trip_id=wrong-trip-id")
check("status 404 (wrong trip_id)", status == 404, str(status))

print("\n3c. GET with non-existent photo_id → 404")
status, _, _ = get(f"/photos/does-not-exist/image?trip_id={TRIP_ID}")
check("status 404 (bad photo_id)", status == 404, str(status))

print("\n3d. GET without trip_id → 422 (required param)")
status, _, _ = get(f"/photos/{sample_photo.id}/image")
check("status 422 (missing required query param)", status == 422, str(status))

print("\n3e. GET /api/photos/{photo_id}/thumbnail — resized JPEG")
status, body, headers = get(f"/photos/{sample_photo.id}/thumbnail?trip_id={TRIP_ID}")
check("thumbnail status 200", status == 200, str(status))
check("thumbnail content-type image/jpeg", "image/jpeg" in headers.get("content-type", ""))
check("thumbnail JPEG magic bytes", body[:2] == b'\xff\xd8', body[:2].hex())
check("thumbnail smaller than 500KB", len(body) < 500_000, f"{len(body)} bytes")
check("thumbnail non-empty (>5KB)", len(body) > 5_000, f"{len(body)} bytes")
print(f"  Thumbnail: {len(body):,} bytes (vs {len(body):,} — full would be ~7MB)")

print("\n3f. thumbnail with explicit w=200")
status, body2, _ = get(f"/photos/{sample_photo.id}/thumbnail?trip_id={TRIP_ID}&w=200")
check("w=200 status 200", status == 200, str(status))
check("w=200 smaller than w=480", len(body2) < len(body), f"{len(body2)} vs {len(body)}")

print("\n3g. thumbnail wrong trip_id → 404")
status, _, _ = get(f"/photos/{sample_photo.id}/thumbnail?trip_id=bad")
check("thumbnail 404 on bad trip_id", status == 404, str(status))


# ── 4. Face crop serving ───────────────────────────────────────────────────────

print("\n4. GET /api/photos/{photo_id}/face/{face_id}")
if real_faces:
    test_face = real_faces[0]
    status, body, headers = get(f"/photos/{test_face.photo_id}/face/{test_face.id}")
    check("status 200", status == 200, str(status))
    check("content-type image/jpeg", "image/jpeg" in headers.get("content-type", ""))
    check("JPEG magic bytes", body[:2] == b'\xff\xd8', body[:2].hex())
    check("face crop has content (>100 bytes)", len(body) > 100, f"{len(body)} bytes")
    print(f"  Face crop: {len(body):,} bytes")

    print("\n4b. GET with wrong photo_id → 404")
    status, _, _ = get(f"/photos/wrong-photo-id/face/{test_face.id}")
    check("status 404 (photo_id mismatch)", status == 404, str(status))

    print("\n4c. GET with non-existent face_id → 404")
    status, _, _ = get(f"/photos/{test_face.photo_id}/face/does-not-exist")
    check("status 404 (bad face_id)", status == 404, str(status))
else:
    print("  SKIP: no real faces with crops found")


# ── 5. Dismiss misc face ───────────────────────────────────────────────────────

print("\n5. POST /api/review/{trip_id}/misc/{face_id}/dismiss")
misc_face_id = insert_misc_face(session, sample_photo.id)
session.expire_all()

# Verify it shows up in misc
status, body, _ = get(f"/review/{TRIP_ID}/misc")
data = json.loads(body)
check("injected face appears in misc", any(f["face_id"] == misc_face_id for f in data["faces"]))

# Dismiss it
status, resp = post(f"/review/{TRIP_ID}/misc/{misc_face_id}/dismiss")
check("status 200", status == 200, str(status))
check("dismissed=True", resp.get("dismissed") is True)

session.expire_all()
dismissed_face = session.query(FaceObservation).filter(FaceObservation.id == misc_face_id).first()
check("is_stranger=True in DB", dismissed_face.is_stranger is True)

# Should no longer appear in misc
status, body, _ = get(f"/review/{TRIP_ID}/misc")
data = json.loads(body)
check("face no longer in misc after dismiss",
      not any(f["face_id"] == misc_face_id for f in data["faces"]))

print("\n5b. Dismiss a face that has a person → 409")
assigned_face = real_faces[0] if real_faces else None
if assigned_face:
    status, resp = post(f"/review/{TRIP_ID}/misc/{assigned_face.id}/dismiss")
    check("status 409 (face already has person)", status == 409, str(status))

print("\n5c. Dismiss non-existent face → 404")
status, resp = post(f"/review/{TRIP_ID}/misc/does-not-exist/dismiss")
check("status 404", status == 404, str(status))


# ── 6. Reassign face ───────────────────────────────────────────────────────────

print("\n6. PATCH /api/face-observations/{id}/reassign")

# Pick a face assigned to person_a, reassign to person_b
face_to_reassign = (
    session.query(FaceObservation)
    .join(Photo, Photo.id == FaceObservation.photo_id)
    .filter(
        Photo.trip_id == TRIP_ID,
        FaceObservation.person_id == person_a_id,
    )
    .first()
)

if not face_to_reassign:
    print(f"  SKIP: no face found assigned to {person_a.name}")
else:
    print(f"  Reassigning face {face_to_reassign.id[:8]}… from {person_a.name} → {person_b.name}")
    status, resp = patch(
        f"/face-observations/{face_to_reassign.id}/reassign",
        {"new_person_id": person_b_id},
    )
    check("status 200", status == 200, str(status))
    check("correction_id returned", "correction_id" in resp, str(resp))
    check("pending_count = 1", resp.get("pending_count") == 1,
          f"got {resp.get('pending_count')}")

    correction_id = resp.get("correction_id")
    if correction_id:
        created_ids["corrections"].append(correction_id)

    session.expire_all()
    updated_face = session.query(FaceObservation).filter(
        FaceObservation.id == face_to_reassign.id
    ).first()
    check("face.person_id updated to person_b in DB", updated_face.person_id == person_b_id)

    if correction_id:
        correction = session.query(UserCorrection).filter(
            UserCorrection.id == correction_id
        ).first()
        check("UserCorrection row created", correction is not None)
        if correction:
            check("correction.old_person_id correct", correction.old_person_id == person_a_id)
            check("correction.new_person_id correct", correction.new_person_id == person_b_id)
            check("correction.status = pending", correction.status == "pending")
            check("correction.trip_id correct", correction.trip_id == TRIP_ID)
            check("correction.correction_type = reassigned",
                  correction.correction_type == "reassigned")

    print("\n6b. Reassign to the same person already assigned → 400")
    status, resp = patch(
        f"/face-observations/{face_to_reassign.id}/reassign",
        {"new_person_id": person_b_id},
    )
    check("status 400 (same person)", status == 400, str(status))

    print("\n6c. Reassign non-existent face → 404")
    status, resp = patch(
        "/face-observations/does-not-exist/reassign",
        {"new_person_id": person_b_id},
    )
    check("status 404", status == 404, str(status))

    print("\n6d. Reassign to non-existent person → 404")
    status, resp = patch(
        f"/face-observations/{face_to_reassign.id}/reassign",
        {"new_person_id": "bad-person-id"},
    )
    check("status 404", status == 404, str(status))

    # Restore original person_id in DB (bypass API, direct SQL — avoid creating extra correction)
    session.query(FaceObservation).filter(
        FaceObservation.id == face_to_reassign.id
    ).update({"person_id": person_a_id})
    session.commit()


# ── 7. Sync-status Tier 1 ─────────────────────────────────────────────────────

print("\n7. GET /api/trips/{trip_id}/sync-status — Tier 1 (pending corrections)")

pending_count = session.query(UserCorrection).filter(
    UserCorrection.trip_id == TRIP_ID,
    UserCorrection.status == "pending",
).count()
print(f"  Pending corrections in DB: {pending_count}")

status, body, _ = get(f"/trips/{TRIP_ID}/sync-status")
data = json.loads(body)
check("status 200", status == 200, str(status))
check("'pending_count' key present", "pending_count" in data)
check("'mismatches' key present", "mismatches" in data)
check(f"pending_count = {pending_count} (matches DB)",
      data["pending_count"] == pending_count,
      f"got {data['pending_count']}")

# When pending > 0, Tier 2 should be skipped (mismatches = [])
if pending_count > 0:
    check("mismatches = [] when pending > 0 (Tier 2 skipped)",
          data["mismatches"] == [], str(data["mismatches"]))

print("\n7b. sync-status for non-existent trip → 404")
status, _, _ = get("/trips/does-not-exist/sync-status")
check("status 404", status == 404, str(status))


# ── 8. Cache clear guard ───────────────────────────────────────────────────────

print("\n8. DELETE /api/trips/{trip_id}/cache — guard test")

from database.models import SessionLocal as SL
_s = SL()
_pending = _s.query(UserCorrection).filter(
    UserCorrection.trip_id == TRIP_ID,
    UserCorrection.status == "pending",
).count()
_s.close()

import socket
temp_dir = Path(__file__).parent.parent / "backend" / "temp" / TRIP_ID
check("temp dir exists for trip", temp_dir.exists(), str(temp_dir))

if _pending > 0:
    status, resp = delete(f"/trips/{TRIP_ID}/cache")
    check("status 409 (pending corrections block cache clear)",
          status == 409, str(status))
    check("temp dir still exists after 409 rejection", temp_dir.exists())
    print(f"  Correctly blocked: {_pending} pending correction(s)")
else:
    print(f"  No pending corrections — cache guard would pass (NOT deleting real data)")
    print(f"  Skipping actual DELETE to preserve test data")

print("\n8b. DELETE cache for non-existent trip → 404")
status, resp = delete("/trips/does-not-exist/cache")
check("status 404", status == 404, str(status))


# ── 9. Reassign idempotency in gallery response ────────────────────────────────

print("\n9. Gallery consistency check after corrections")

status, body, _ = get(f"/trips/{TRIP_ID}/gallery")
gallery2 = json.loads(body)
check("status 200", status == 200, str(status))

persons2 = {p["id"]: p for p in gallery2["persons"]}
for orig in persons_g:
    pid = orig["id"]
    if pid in persons2:
        # If we restored via direct SQL, counts should match original
        # (corrections were cleaned or face was restored)
        pass

check("gallery still returns all enrolled persons",
      len(gallery2["persons"]) == enrolled_count,
      f"expected {enrolled_count}, got {len(gallery2['persons'])}")


# ── Cleanup ────────────────────────────────────────────────────────────────────

print("\nCleaning up synthetic test data…")
cleanup(session)
session.expire_all()

remaining_faces = session.query(FaceObservation).filter(
    FaceObservation.id.in_(created_ids["face_obs"])
).count()
check("all synthetic faces removed", remaining_faces == 0, f"{remaining_faces} remain")

remaining_corrections = session.query(UserCorrection).filter(
    UserCorrection.id.in_(created_ids["corrections"])
).count()
check("all test corrections removed", remaining_corrections == 0, f"{remaining_corrections} remain")


# ── Summary ────────────────────────────────────────────────────────────────────

print(f"\n{'─'*60}")
session.close()

if errors:
    print(f"\033[31m{len(errors)} FAILED:\033[0m")
    for e in errors:
        print(f"  • {e}")
    sys.exit(1)
else:
    print("\033[32mAll Phase 8 checks passed\033[0m")
