"""
Phase 4 smoke test — review page + Misc assign/create.

Run from backend/ with the venv active and backend running at localhost:8000:
    python ../tests/test_phase4.py

Prerequisites: trip must be in 'uploaded' status (Phase 3 complete).
"""
import json
import sys
import uuid
import numpy as np
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from database.models import SessionLocal, FaceObservation, Photo, Person, PersonEmbedding, TripPerson

TRIP_ID = "11dcb4d4-b24c-4466-b19a-f01eb6156980"
BASE = "http://localhost:8000/api"
PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"

errors = []
created_ids: dict[str, list[str]] = {"face_obs": [], "persons": [], "embeddings": [], "trip_persons": []}


def check(label, condition, detail=""):
    if condition:
        print(f"  {PASS} {label}")
    else:
        print(f"  {FAIL} {label}{': ' + detail if detail else ''}")
        errors.append(label)


def get(path):
    try:
        with urllib.request.urlopen(f"{BASE}{path}") as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def make_normed_embedding() -> bytes:
    v = np.random.randn(512).astype(np.float32)
    v /= np.linalg.norm(v)
    return v.tobytes()


def insert_misc_face(session, photo_id: str, with_embedding: bool = True) -> str:
    """Insert a synthetic unmatched face. Returns face_id."""
    face = FaceObservation(
        id=str(uuid.uuid4()),
        photo_id=photo_id,
        person_id=None,
        is_stranger=False,
        confidence=0.75,
        raw_embedding=make_normed_embedding() if with_embedding else None,
        face_crop=None,
    )
    session.add(face)
    session.commit()
    created_ids["face_obs"].append(face.id)
    return face.id


def cleanup(session):
    """Remove all synthetic rows created during the test."""
    for fid in created_ids["face_obs"]:
        f = session.query(FaceObservation).filter(FaceObservation.id == fid).first()
        if f:
            session.delete(f)
    for eid in created_ids["embeddings"]:
        e = session.query(PersonEmbedding).filter(PersonEmbedding.id == eid).first()
        if e:
            session.delete(e)
    for tp_key in created_ids["trip_persons"]:
        # stored as "trip_id:person_id"
        tid, pid = tp_key.split(":", 1)
        tp = session.query(TripPerson).filter(
            TripPerson.trip_id == tid, TripPerson.person_id == pid
        ).first()
        if tp:
            session.delete(tp)
    for pid in created_ids["persons"]:
        p = session.query(Person).filter(Person.id == pid).first()
        if p:
            session.delete(p)
    session.commit()


# ── Setup ──────────────────────────────────────────────────────────────────────

session = SessionLocal()

trip_persons = session.query(TripPerson).filter(TripPerson.trip_id == TRIP_ID).all()
if not trip_persons:
    print(f"{FAIL} No trip persons for {TRIP_ID} — run Phase 2 first")
    sys.exit(1)

first_person_id = trip_persons[0].person_id
first_person = session.query(Person).filter(Person.id == first_person_id).first()
sample_photo = session.query(Photo).filter(Photo.trip_id == TRIP_ID).first()

if not sample_photo:
    print(f"{FAIL} No photos in trip")
    sys.exit(1)

# Check backend is reachable
try:
    urllib.request.urlopen(f"http://localhost:8000/api/health").read()
except Exception:
    print(f"{FAIL} Backend not reachable at localhost:8000 — start it first")
    sys.exit(1)

print(f"\nTrip: {TRIP_ID}")
print(f"Sample person: {first_person.name!r} ({first_person_id})")
print(f"Sample photo:  {sample_photo.drive_file_name!r} ({sample_photo.id})\n")


# ── 1. Misc endpoint with real data (0 misc) ───────────────────────────────────

print("1. GET /api/review/{trip_id}/misc — real data (expect 0)")
status, body, _ = get(f"/review/{TRIP_ID}/misc")
data = json.loads(body)
check("status 200", status == 200, str(status))
check("'faces' key present", "faces" in data)
check("'count' key present", "count" in data)
check("count = 0 (all enrolled or dismissed)", data["count"] == 0, f"got {data['count']}")
check("faces list empty", data["faces"] == [])


# ── 2. Misc endpoint with synthetic data ───────────────────────────────────────

print("\n2. GET /api/review/{trip_id}/misc — after injecting synthetic face")
synthetic_id = insert_misc_face(session, sample_photo.id)
session.expire_all()

status, body, _ = get(f"/review/{TRIP_ID}/misc")
data = json.loads(body)
check("status 200", status == 200)
check("count = 1", data["count"] == 1, f"got {data['count']}")
check("face_id matches injected", data["faces"][0]["face_id"] == synthetic_id)
check("photo_name present", data["faces"][0]["photo_name"] == sample_photo.drive_file_name)
check("confidence present", data["faces"][0]["confidence"] is not None)


# ── 3. Assign misc face to existing person ─────────────────────────────────────

print("\n3. POST /api/review/{trip_id}/misc/{face_id}/assign")
status, resp = post(f"/review/{TRIP_ID}/misc/{synthetic_id}/assign", {"person_id": first_person_id})
check("status 200", status == 200, str(status))
check("assigned=True", resp.get("assigned") is True)
check("person_id matches", resp.get("person_id") == first_person_id)
check("person_name matches", resp.get("person_name") == first_person.name)

session.expire_all()
face = session.query(FaceObservation).filter(FaceObservation.id == synthetic_id).first()
check("FaceObservation.person_id updated in DB", face.person_id == first_person_id)

new_emb = (
    session.query(PersonEmbedding)
    .filter(PersonEmbedding.person_id == first_person_id, PersonEmbedding.source_photo_id == sample_photo.id)
    .order_by(PersonEmbedding.id.desc())
    .first()
)
check("PersonEmbedding created", new_emb is not None)
if new_emb:
    arr = np.frombuffer(new_emb.embedding, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    check("embedding L2-normalized (norm≈1.0)", abs(norm - 1.0) < 0.01, f"norm={norm:.4f}")
    created_ids["embeddings"].append(new_emb.id)

# Misc count should now drop back to 0
status, body, _ = get(f"/review/{TRIP_ID}/misc")
data = json.loads(body)
check("misc count = 0 after assign", data["count"] == 0, f"got {data['count']}")

# Assign again → 409
print("\n4. POST assign already-assigned face → 409")
status, resp = post(f"/review/{TRIP_ID}/misc/{synthetic_id}/assign", {"person_id": first_person_id})
check("status 409 (already assigned)", status == 409, str(status))

# Assign to bad person → 404
print("\n5. POST assign to non-existent person → 404")
face2_id = insert_misc_face(session, sample_photo.id)
session.expire_all()
status, resp = post(f"/review/{TRIP_ID}/misc/{face2_id}/assign", {"person_id": "does-not-exist"})
check("status 404", status == 404, str(status))
# face should remain unassigned
session.expire_all()
face2 = session.query(FaceObservation).filter(FaceObservation.id == face2_id).first()
check("face still unassigned after bad assign", face2.person_id is None)


# ── 6. Create new person from misc face ────────────────────────────────────────

print("\n6. POST /api/review/{trip_id}/misc/{face_id}/create")
status, resp = post(f"/review/{TRIP_ID}/misc/{face2_id}/create", {"name": "TEST_PHASE4_PERSON"})
check("status 200", status == 200, str(status))
check("person_id returned", "person_id" in resp)
check("name matches", resp.get("name") == "TEST_PHASE4_PERSON")

if "person_id" in resp:
    new_pid = resp["person_id"]
    created_ids["persons"].append(new_pid)
    created_ids["trip_persons"].append(f"{TRIP_ID}:{new_pid}")

    session.expire_all()
    new_person = session.query(Person).filter(Person.id == new_pid).first()
    check("Person row created", new_person is not None)
    if new_person:
        check("Person.name correct", new_person.name == "TEST_PHASE4_PERSON")

    tp = session.query(TripPerson).filter(
        TripPerson.trip_id == TRIP_ID, TripPerson.person_id == new_pid
    ).first()
    check("TripPerson row created", tp is not None)

    face2 = session.query(FaceObservation).filter(FaceObservation.id == face2_id).first()
    check("FaceObservation.person_id = new person", face2.person_id == new_pid)

    emb = session.query(PersonEmbedding).filter(PersonEmbedding.person_id == new_pid).first()
    check("PersonEmbedding created for new person", emb is not None)
    if emb:
        arr = np.frombuffer(emb.embedding, dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        check("new person embedding L2-normalized", abs(norm - 1.0) < 0.01, f"norm={norm:.4f}")
        created_ids["embeddings"].append(emb.id)

# Create with empty name → 400
print("\n7. POST create with empty name → 400")
face3_id = insert_misc_face(session, sample_photo.id)
session.expire_all()
status, resp = post(f"/review/{TRIP_ID}/misc/{face3_id}/create", {"name": "   "})
check("status 400", status == 400, str(status))

# ── 8. Persons list ────────────────────────────────────────────────────────────

print("\n8. GET /api/persons/")
status, body, _ = get("/persons/")
persons_list = json.loads(body)
check("status 200", status == 200)
check("returns list", isinstance(persons_list, list))
# 9 original + 1 new created above
check("at least 10 persons (9 original + 1 test)", len(persons_list) >= 10, f"got {len(persons_list)}")
check("each item has id + name", all("id" in p and "name" in p for p in persons_list))
check("sorted by name", persons_list == sorted(persons_list, key=lambda p: p["name"]))


# ── 9. Person thumbnail ────────────────────────────────────────────────────────

print("\n9. GET /api/persons/{id}/thumbnail")
status, body, headers = get(f"/persons/{first_person_id}/thumbnail")
check("status 200", status == 200, str(status))
check("content-type image/jpeg", "image/jpeg" in headers.get("content-type", ""))
check("non-empty JPEG body", len(body) > 100, f"{len(body)} bytes")
check("JPEG magic bytes (FF D8)", body[:2] == b'\xff\xd8', f"got {body[:2].hex()}")
print(f"     Thumbnail size: {len(body)} bytes ({first_person.name!r})")

print("\n10. GET /api/persons/does-not-exist/thumbnail → 404")
status, body, _ = get("/persons/does-not-exist/thumbnail")
check("status 404", status == 404, str(status))


# ── 11. classify results still correct ────────────────────────────────────────

print("\n11. GET /api/classify/{trip_id}/results — integrity after synthetic ops")
status, body, _ = get(f"/classify/{TRIP_ID}/results")
data = json.loads(body)
check("status 200", status == 200)
# The newly created test person (TEST_PHASE4_PERSON) will appear here since face2 is assigned to it
check("persons list present", "persons" in data)
check("all photo_counts ≥ 0", all(p["photo_count"] >= 0 for p in data["persons"]))
check("scene_counts present", "scene_counts" in data)


# ── Cleanup ────────────────────────────────────────────────────────────────────

print("\nCleaning up synthetic test data…")
# Reset face3 (empty-name test) — still unassigned, just delete it
face3 = session.query(FaceObservation).filter(FaceObservation.id == face3_id).first()
if face3:
    session.delete(face3)
session.commit()

cleanup(session)
session.expire_all()

# Verify cleanup
remaining = session.query(FaceObservation).filter(
    FaceObservation.id.in_(created_ids["face_obs"])
).count()
check("all synthetic faces removed", remaining == 0, f"{remaining} remain")

remaining_persons = session.query(Person).filter(Person.id.in_(created_ids["persons"])).count()
check("test person removed", remaining_persons == 0, f"{remaining_persons} remain")

# Confirm misc is back to 0
status, body, _ = get(f"/review/{TRIP_ID}/misc")
data = json.loads(body)
check("misc count = 0 after cleanup", data["count"] == 0, f"got {data['count']}")


# ── Summary ────────────────────────────────────────────────────────────────────

print(f"\n{'─'*50}")
session.close()

if errors:
    print(f"\033[31m{len(errors)} FAILED:\033[0m")
    for e in errors:
        print(f"  • {e}")
    sys.exit(1)
else:
    print(f"\033[32mAll Phase 4 checks passed\033[0m")
