# Lessons register

Every problem this project has hit since Phase 0 (2026-06) and how it was solved, grouped by the part of the system it lives in. Before touching an area, read its section: each entry is Symptom · Root cause · Fix · Prevent, and the last section is the checklist distilled from all of them. `docs/BUGS.md` (private, gitignored) keeps the long-form write-ups for the pipeline ones; this file is the register you actually scan, and it is committed so it survives machines and sessions.

---

## 1. Google Drive API & OAuth

**credentials.json downloaded without an extension (2026-06, Phase 0)**
- Symptom: `FileNotFoundError: credentials.json not found in backend/` right after downloading the OAuth client.
- Root cause: Cloud Console names the file `credentials`, no `.json`.
- Fix: rename it; documented in `docs/BUGS.md` #6.
- Prevent: the setup doc says so; check `ls backend/credentials*` before blaming the code.

**OAuth 403 access_denied on consent (2026-06, Phase 0)**
- Symptom: browser consent completes, Google returns `403 access_denied`.
- Root cause: consent screen in Testing mode only admits listed Test Users.
- Fix: add the Google account under OAuth consent screen → Test users (`docs/BUGS.md` #7).
- Prevent: every new Google account that will authorize must be a test user until the app is published.

**Refresh token dies after 7 days (found 2026-07-03, again 2026-09)**
- Symptom: `invalid_grant: Token has been expired or revoked` although `backend/token.json` exists and worked.
- Root cause: Testing-mode consent screens issue refresh tokens Google expires after 7 days.
- Fix: delete `backend/token.json` and re-consent (`docs/BUGS.md` #8). Permanent: publish the consent screen.
- Prevent: publish the consent screen before any multi-week gap; expect a re-auth after every idle week until then.

**Dead token failed every Drive call until someone deleted token.json (2026-07-03; fixed 2026-09-29)**
- Symptom: `invalid_grant` on refresh, and `get_drive_service()` only ran the consent flow when no refresh token existed — so the upload failed on every click until `backend/token.json` was deleted by hand.
- Root cause: `creds.refresh()` raised `RefreshError` and nothing caught it.
- Fix: `drive/auth.py` catches `RefreshError`, deletes the dead token and re-runs the consent flow (a browser window opens on this machine; the upload thread waits for it).
- Prevent: `InstalledAppFlow.run_local_server` is synchronous and browser-bound — only call `get_drive_service()` from a background thread or a script, never from a request handler; stage 4 replaces this with a bot account refreshed out of band.

**Drive service objects are not thread-safe (2026-07-03, `74b6c01`, `859a123`)**
- Symptom: sporadic failures when downloads/shortcut creates ran in a thread pool sharing one service.
- Root cause: `googleapiclient` service objects carry per-request state.
- Fix: one service per worker via `threading.local()` in `drive/ingest.py` and `drive/output.py`.
- Prevent: any new Drive parallelism gets its service from `_thread_service()`, never from a module global.

**Serial upload: two HTTP round-trips per shortcut (2026-07-03, `859a123`)**
- Symptom: 1000-photo upload took many minutes.
- Root cause: `list` (existence check) + `create` for every shortcut, sequentially.
- Fix: plan the worklist from the DB first, 10-thread pool, skip existence checks when `[Organized]` was just created.
- Prevent: `plan_trip_output()` (2026-09-29) is a pure DB function; keep Drive calls out of planning so it stays dry-runnable.

**Exact duplicates downloaded before being detected (2026-07-03, `74b6c01`)**
- Symptom: duplicates cost a full download each; pHash only ran after the bytes arrived.
- Root cause: `files.list` was not asked for `md5Checksum`.
- Fix: request `md5Checksum` + `size`, dedupe before download; pHash still catches near-dups (exact-equality only, see §5).
- Prevent: when adding a Drive listing field, check what `files.list` gives for free before downloading.

**Sync-status false mismatches (2026-06-18, session 4)**
- Symptom: gallery banner reported Drive/DB mismatches for every person.
- Root cause: `api/sync.py` counted face observations, Drive holds one shortcut per photo.
- Fix: count `distinct(photo_id)` per person, matching how `drive/output.py` creates shortcuts.
- Prevent: any count compared against Drive must use the same unit the output builder uses (photos, not faces).

**Review assignments never reach Drive (found 2026-09-26, OPEN)**
- Symptom: assigning or creating a person from Misc changes the DB, re-upload adds new shortcuts but stale `Misc/` ones stay.
- Root cause: `api/review.py` assign/create/bulk-assign write no `UserCorrection`; only gallery reassign does.
- Fix: not done; lands with the stage-3 output rework (in-app gallery primary, Drive optional).
- Prevent: any endpoint that moves a face between people must either write a `UserCorrection` or be covered by a full re-plan on upload.

**Google policy facts that shape the architecture (verified 2026-09-26)**
- Symptom: plan assumed per-friend OAuth would scale.
- Root cause: `drive` scopes are restricted (CASA assessment), unverified apps cap at 100 users for life, service accounts have no My Drive quota, `drive.file` + Picker cannot list a folder.
- Fix: decided on a bot Google account the user shares the folder with; Google Sign-In only for identity.
- Prevent: re-read `session10` notes before any tenancy or scope change; do not design around per-user Drive consent.

**Videos never got a shortcut (audit 2026-09-29, fixed same day)**
- Symptom: README promised `Videos/`; the planner skipped every `is_video` row (Kochi: 12 `.MOV`), so the "0 unrouted" dry-run was true only by construction.
- Root cause: the skip branch was written as "not a photo".
- Fix: `("Videos",)` folder in `plan_trip_output`; plan 1705 → 1717 shortcuts.
- Prevent: every file class the README lists has a branch in the planner, and the dry-run's per-folder counts must add up to the processable total.

**No retries on Drive writes; per-item failures swallowed (audit 2026-09-29, fixed same day)**
- Symptom: a 403 rate-limit burst during 10-way shortcut creation would drop photos from the tree while the trip still said "uploaded".
- Root cause: `execute()` defaults to `num_retries=0`; the worker loop only printed the exception.
- Fix: `num_retries=DRIVE_RETRIES` on every Drive call; `failed` counted into the upload progress and shown next to the result.
- Prevent: every Drive call passes the retry constant; a bulk step reports its failure count in its done payload, never only successes.

**Re-upload never removed shortcuts that no longer belong (audit 2026-09-29, fixed same day)**
- Symptom: a photo moved out of Misc by Review, or reassigned in the gallery, stayed in its old Drive folder forever; Sync only handled gallery corrections.
- Root cause: the builder only created; dedupe was per (name, parent, target).
- Fix: `prune_stale_shortcuts` walks every folder under `[Organized]` and deletes shortcuts whose target isn't planned there (shortcuts only, never folders or files); unit-checked against a fake tree.
- Prevent: a step that syncs to an external system reconciles both ways — create what is missing, remove what is extra — and is tested with a stub before it touches the real account.

**Drive query literals were not escaped (audit 2026-09-29, fixed same day)**
- Symptom: a person or file named `O'Brien` would 400 the folder lookup and abort the upload.
- Fix: `_q()` escapes `\` and `'` in every `q=` string.
- Prevent: never interpolate a user-controlled name into a query string without the escape helper.

**Gallery load waited on a Drive check (audit 2026-09-29, fixed same day)**
- Symptom: after an upload, `sync-status` verified every person folder on Drive (two calls per person) on every gallery load — and behind a dead token that call blocks on OAuth consent, so the page would have hung.
- Fix: verification is opt-in (`?verify=1`); the gallery renders from trip + gallery data and fetches the pending badge afterwards with its own catch.
- Prevent: nothing on a page's render path calls an external service; secondary data loads after first paint and can fail alone.

---

## 2. SQLAlchemy / SQLite

**Identity map returns stale rows after a background thread commits (2026-06, Phase 0)**
- Symptom: SSE progress endpoints kept reporting pre-commit values although the DB had moved on.
- Root cause: each session caches ORM objects by PK; another session's commit never invalidates them.
- Fix: `session.expire_all()` before re-reading anything a thread may have changed (`docs/BUGS.md` #1).
- Prevent: every status read after a background job goes through a fresh query with `expire_all()` first.

**`create_all()` never adds columns (2026-06, Phase 0–1; fixed 2026-09-29)**
- Symptom: `no column named X` at insert time after adding a model column; hit at least three times.
- Root cause: `Base.metadata.create_all()` creates missing tables only.
- Fix: manual `ALTER TABLE` each time (`docs/BUGS.md` #3); now a startup `ensure_columns` migration in `database/models.py` adds any model column missing from the live table.
- Prevent: add the column to the model, restart, check `sqlite3 registry.db ".schema <table>"`; column removals and type changes still need a hand-written migration.

**Deleting a Person blows up on the composite-PK link table (2026-06-18, session 5)**
- Symptom: `AssertionError: Dependency rule tried to blank-out primary key column` from `session.delete(person)`.
- Root cause: `TripPerson(trip_id, person_id)` is a composite PK with no cascade; the unit of work tries to NULL a PK. Three ORM workarounds failed.
- Fix: raw `session.execute(text(...))` for the whole delete in `enrollment/router.py`.
- Prevent: never `session.delete()` a model that owns a composite-PK FK relationship without cascade; write the SQL.

**Deleting a Trip returned HTTP 500 (2026-06-19, session 6)**
- Symptom: `DELETE /trips/{id}` 500 with an IntegrityError.
- Root cause: five tables hold `trip_id` FKs with no relationship on `Trip` (`TripPerson`, `UserCorrection`, `PersonOutfit`, `UnmatchedPerson`, `PotentialMisclassification`).
- Fix: bulk-delete those five first, then `session.delete(trip)` cascades Trip → Photo → FaceObservation (`api/trips.py`).
- Prevent: every new table with a `trip_id` FK is added to that pre-delete block in the same commit.

**ORM objects handed to worker threads (2026-07-03, `4650f7c`)**
- Symptom: face pipeline died mid-trip with `IndexError: tuple index out of range` inside `sqlalchemy.cyextension.resultproxy`.
- Root cause: `commit()` expires attributes; a decode thread touching `photo.local_path` triggered a lazy reload on the shared, non-thread-safe session.
- Fix: snapshot plain `(id, local_path)` tuples before the first commit; threads get values only (`docs/BUGS.md` #9).
- Prevent: any `def load(...)` inside a pool call that accepts a mapped instance is wrong; pass ids, paths, bytes.

**numpy scalars rejected at the API boundary (2026-06, Phase 2)**
- Symptom: 500 from the cluster endpoint, `TypeError: 'numpy.int64' object is not iterable`.
- Root cause: sklearn/numpy return numpy scalar types; FastAPI's encoder does not know them.
- Fix: `int()` / `float()` / `bool()` at the boundary (`docs/BUGS.md` #4 and the closing pattern).
- Prevent: any endpoint returning sklearn/numpy output converts scalars before building the dict.

**DB bbox values arrive as non-int (2026-06-19, session 8)**
- Symptom: `TypeError` on integer slicing in `api/body.py`.
- Root cause: coordinates read from the DB were float/Decimal; `fw // 2` stayed float.
- Fix: cast `int(...)` on read.
- Prevent: any pixel coordinate taken from the DB is cast to `int` before arithmetic.

**Per-photo commits during ingestion (2026-07-03, `74b6c01`)**
- Symptom: ingestion dominated by fsync, one commit per photo.
- Root cause: a commit inside the download loop.
- Fix: coordinator-thread writes only, committed in batches of 50; face pipeline commits every 25 photos.
- Prevent: pipeline loops commit per batch, never per row.

**Status transitions bypassed `crud.update_trip_status` (found 2026-09-29, fixed same day)**
- Symptom: Kochi sat at `status=classified` with `last_good_status=faces_extracted`; the first upload failure (dead token) would have rolled the UI back to "Start Enrollment".
- Root cause: `pipeline/classify.py`, `pipeline/body.py`, `drive/output.py` and `enrollment/router.py` wrote `Trip.status` directly, skipping the helper that maintains `last_good_status` and clears `error_message`.
- Fix: every transition goes through `crud.update_trip_status`; a face re-run on an enrolled trip lands back at `enrolled` (roster kept) instead of `faces_extracted`.
- Prevent: grep for `"status":` / `trip.status =` outside `database/crud.py` in review; the helper is the only writer.

**Re-ingest after Clear Cache marked every photo an exact duplicate of itself (audit 2026-09-29, fixed same day)**
- Symptom: `DELETE /trips/{id}/cache` then Ingest would insert 1139 junk `is_duplicate` rows pointing at their own originals, download nothing, and leave every original with a dead `local_path`.
- Root cause: the md5 dedupe map was seeded from all existing rows, including the ones whose file was gone and therefore pending re-download.
- Fix: rows with a missing file are excluded from the seed maps and re-downloaded into the same row (faces and enrollment keep their photo id); exercised against a stubbed Drive and a temp DB.
- Prevent: when a resume guard puts a row back into the work queue, the row must not also be a dedupe reference; test the "second run" of every idempotent step, not only the first.

**Removing a person left this trip's registry embeddings behind (audit 2026-09-29, fixed same day)**
- Symptom: the next classify re-matched the freed faces against their own embeddings (cosine 1.0) and re-linked the person; the removal undid itself.
- Root cause: `delete_enrolled_person` only deleted embeddings when the person was in no other trip.
- Fix: embeddings whose `source_photo_id` is in this trip are deleted on removal; a gallery reassign moves the matching embedding to the new person.
- Prevent: every undo path deletes or moves the derived rows it created, not just the flag on the primary row.

---

## 3. ML models & image pipeline

**Raw InsightFace embedding stored instead of the normalized one (2026-06, Phase 1)**
- Symptom: embeddings with norm ≈ 22; cosine search silently wrong.
- Root cause: `face.embedding` is unnormalized; `face.normed_embedding` has norm 1.
- Fix: store `normed_embedding` (`docs/BUGS.md` #2); the Phase-1 test asserts the norm.
- Prevent: any embedding store test asserts norm ≈ 1.0; inner product is cosine only for unit vectors.

**FAISS + PyTorch in one process segfaults on macOS ARM64 (2026-06, Phase 3; gone 2026-07-03, `13e57ba`)**
- Symptom: exit code 139 inside `libomp.dylib` when both were imported.
- Root cause: two bundled OpenMP runtimes; env vars and thread counts do not help.
- Fix: torch work ran in subprocess workers; then FAISS was removed for a numpy matmul and the workers were deleted (`docs/BUGS.md` #5).
- Prevent: before adding an ML library, check whether it ships its own `libomp`; prefer numpy at registry scale.

**InsightFace fed RGB, expects BGR (found 2026-09-26, fixed 2026-09-27, `2ca8283`)**
- Symptom: no error; same-person clusters fragmented (32- and 23-face side clusters), more singletons.
- Root cause: the model zoo is written for cv2 input and swaps channels itself; PIL arrays are RGB. cos(RGB,BGR) of the same face ≈ 0.88.
- Fix: `cv2.cvtColor(img, COLOR_RGB2BGR)` for the model only; crops and blur stay RGB (`docs/BUGS.md` #10).
- Prevent: cv2-native models get BGR, PIL/torch/open_clip models get RGB; write the channel order at every hand-off.

**EXIF orientation not applied before detection (found 2026-09-27, `42f3b5e`)**
- Symptom: fewer, weaker faces on 155 phone JPEGs; bboxes drawn in the wrong place on anything shown upright.
- Root cause: `_load_image` did `Image.open` + resize with no `exif_transpose`; every consumer honours EXIF.
- Fix: transpose first in `pipeline/face.py`, `utils/image.py`, `pipeline/scene.py`; detection space = upright image, long side ≤ 1920 (`docs/BUGS.md` #11).
- Prevent: any new image loader calls `ImageOps.exif_transpose` before anything else; coordinates only make sense in the upright frame.

**Three unused InsightFace sub-models loaded and run (found 2026-09-26, `2ca8283`)**
- Symptom: ~30% extra CPU per face, ~150 MB extra weights, nothing read the outputs.
- Root cause: default `FaceAnalysis` loads landmark and gender/age models.
- Fix: `allowed_modules=["detection", "recognition"]`.
- Prevent: when adopting a model package, list what runs per item and disable what nothing consumes.

**Stored bboxes are in detection space, overlays assumed original pixels (2026-06-19, session 8)**
- Symptom: gallery lightbox boxes drawn at ~half the right position.
- Root cause: the pipeline resizes to `MAX_LONG_SIDE = 1920`; the overlay scaled from natural size directly.
- Fix: divide by `min(1920 / longSide, 1)` before mapping to display (`Gallery.tsx`); Enroll positions boxes as percentages of `det_width/det_height` served by the API.
- Prevent: any consumer of stored coordinates states which space it is in; serve `det_width/det_height` rather than measuring images client-side.

**Body boxes in original pixels, face boxes in detection space (2026-06, Phase 6; fixed 2026-07-03, `7122ab1`)**
- Symptom: face↔body association silently failed on photos wider than 1920 px.
- Root cause: YOLO ran on the full-res cv2 image while faces were detected on the resized one.
- Fix: body detection uses the same 1920-long-side PIL-loaded image; association by containment ≥ 0.6.
- Prevent: one shared loader (`utils/image.open_for_processing`) for every pixel pipeline; never introduce a second coordinate space.

**cv2 cannot read HEIC (2026-06-19, session 8)**
- Symptom: body histograms silently skipped every HEIC photo; iPhone-heavy trips had near-zero coverage.
- Root cause: `cv2.imread` returns `None` for HEIC.
- Fix: decode via PIL + `pillow_heif`, hand cv2 the array.
- Prevent: no `cv2.imread` on photo files; decode with PIL, then convert.

**pillow_heif only worked by accident (2026-06-19, session 8; GAP 7)**
- Symptom: HEIC face detection depended on whether a gallery request had run first in the same process.
- Root cause: `register_heif_opener()` is process-global and was only called in gallery endpoints.
- Fix: registered at module import in `pipeline/face.py`, `pipeline/scene.py`, gallery helpers.
- Prevent: every module that opens photos registers the opener at import time.

**cv2 asserts on an empty slice (2026-06-19, session 8)**
- Symptom: `detect-misclassifications` 500 with `AssertionError: !_src.empty()`.
- Root cause: numpy slicing past the image edge returns a 0-element array without raising; `bw > 0` guards do not catch it.
- Fix: `if region.size == 0: return None` after slicing.
- Prevent: every numpy slice handed to cv2 is size-checked after the slice, not before.

**DBSCAN eps tuned on 51 photos chained 969 faces into one cluster (2026-06-19, session 7)**
- Symptom: one mega-cluster on the first 1096-photo trip.
- Root cause: `eps=0.6` lets faces at 40% similarity chain transitively; `min_samples=1` has no noise concept.
- Fix: `eps=0.35` then (v2) agglomerative average-linkage ≤ 0.45 with two-stage singleton attachment (`b579e53`).
- Prevent: tune thresholds on the largest real trip available, keep them as named constants at module top (table in `docs/CHANGELOG-v2.md`).

**Every detected face reached review: the singleton flood (2026-07-03, `b579e53`)**
- Symptom: hundreds of blurry, tiny bystander faces in Enroll.
- Root cause: no quality gate; the detector finds far more than a human can name.
- Fix: `is_low_quality` = det_score < 0.65, face < 40 px, Laplacian variance < 45; hidden from clustering, still matched during classify.
- Prevent: any new face source runs through `_face_quality` before it can reach a review queue.

**Low-quality faces auto-match at the sharp-face threshold (found 2026-09-26, OPEN)**
- Symptom: blurry faces assigned to people at the same 0.50/0.10 rule as sharp ones.
- Root cause: `_match_faces` in `pipeline/classify.py` ignores `is_low_quality`.
- Fix: not done; candidate is a stricter threshold for low-quality faces.
- Prevent: when touching matching, treat the quality flag as an input, not just a review filter.

**"a photo of other" was a real prompt (fixed 2026-07-03, `13e57ba`)**
- Symptom: "other" predicted directly by CLIP, meaningless label competition.
- Root cause: fallback label included in the zero-shot vocabulary.
- Fix: SigLIP 2 with prompt ensembles; "other" assigned only via a softmax floor (< 0.30).
- Prevent: fallback classes are decided by confidence, never by a prompt.

**SigLIP 2 setup surprises (2026-07-03)**
- Symptom: `ModuleNotFoundError` for the tokenizer; wrong input size and dimension assumptions.
- Root cause: `open_clip.get_tokenizer('ViT-B-16-SigLIP2')` imports `transformers`; the base model is 224 px and 768-dim.
- Fix: `transformers` in requirements; constants corrected.
- Prevent: probe a new model's tokenizer, input size and output dim in a scratch script before wiring it in.

**Scene labels only for no-face photos (found 2026-09-26, fixed 2026-09-29, `1ef877a`)**
- Symptom: Places excluded every photo with a person; dismissed-only photos had no label to file under.
- Root cause: `classify_scenes` filtered `face_count == 0`.
- Fix: label every processable photo; re-runs fill only missing labels so gallery corrections survive.
- Prevent: pipeline outputs are computed for all photos; routing decides who sees them.

**Face re-run duplicated assigned faces and dropped dismissed ones (found 2026-09-29, fixed same day)**
- Symptom: re-running Extract Faces after enrollment re-detects everything, so assigned faces gained a second unassigned row and `is_stranger` rows (person_id NULL) were deleted.
- Root cause: the idempotency rule in `pipeline/face.py` deleted `person_id IS NULL` rows and inserted all new detections without looking at survivors.
- Fix: reconcile new detections against existing rows by bbox IoU; rows carrying a user decision (assigned or dismissed) are kept and refreshed, the rest replaced.
- Prevent: any "idempotent re-run" that keeps some rows must match new output against them; deleting by a status column is not reconciliation.

**Rotated face crops in Review (found 2026-09-29, fixed same day)**
- Symptom: 25 of 85 review-queue faces shown sideways; 11 of them were members that never matched (registry similarity 0.26 sideways vs 0.69 upright).
- Root cause: DSLR/phone files stored sideways with no EXIF tag; crops are cut from the upright-by-EXIF image and `face.kps` was never used.
- Fix: rotate-and-retry in `pipeline/face.py` — roll from the eye line, quarter-turn the image, re-detect, keep the upright embedding + crop; `rotation` column; `/photos/{p}/face/{f}/context` rotates its crop.
- Prevent: keypoints are part of detection output; when a model gives geometry, store what display and matching need.

**Thresholds validated on synthetic data only (2026-07-03)**
- Symptom: v2 shipped with constants "validated on probes", first real run needed the BGR/EXIF fixes to cluster cleanly.
- Root cause: no real trip had been run end-to-end past enrollment until 2026-09-27.
- Fix: Kochi verification run; numbers recorded in `docs/CHANGELOG-v2.md`.
- Prevent: a pipeline change is done when it has run on the real trip and the before/after counts are written down.

**Every stage re-decodes full-res originals (found 2026-09-26, OPEN)**
- Symptom: decode dominates (77 ms/img) while inference is 8–40 ms; thumbnails and HEIC conversion repeat per request.
- Root cause: no working copy or thumbnail cache; stage 3 (one pixel pass) addresses it.
- Prevent: new pipeline stages read the shared loader, not the original file, and stage 3 makes that a 1920 px working copy.

**Near-duplicate detection is exact pHash equality (found 2026-09-26, OPEN)**
- Symptom: burst shots pass as unique.
- Root cause: `crud.find_duplicate` compares hashes for equality.
- Prevent: use Hamming distance ≤ 6–8 when touching dedupe.

---

## 4. Background jobs & threads

**Progress and stats live in memory (2026-06-18 GAP 1; 2026-09-26 #5, OPEN until stage 2)**
- Symptom: after a uvicorn restart, body stats vanish and a trip mid-step stays `ingesting` / `extracting_faces` / `body_detecting` forever; status guards then refuse a re-run.
- Root cause: four in-memory progress dicts plus daemon threads inside the API process; no persisted job row.
- Fix: not done; stage 2 (Postgres + jobs table with leases) replaces the dicts.
- Prevent: do not add a fifth progress dict; new long-running work waits for the jobs table.

**SSE endpoints are the only progress surface**
- Symptom: CLI polling of `*-snapshot` endpoints that do not exist.
- Root cause: progress is streamed only.
- Fix: poll `GET /api/trips/{id}` for status, or `curl -sN --max-time 600 .../progress` in a background shell until done/error.
- Prevent: keep the trip row authoritative for status; SSE is a convenience.

**Pipeline re-run under an open browser tab (2026-09-27)**
- Symptom: Enroll's Save sent stale face IDs → 404 "No faces found for given IDs".
- Root cause: the re-run deleted and recreated face rows while Vite HMR preserved React state.
- Fix: hard reload.
- Prevent: never run a face re-run while the UI is open on that trip; classify re-runs are safe (no row deletion). Offered guard: refetch on 404.

**Model singletons and thread pools**
- Symptom: none yet; pattern worth keeping.
- Root cause: models are expensive to load and not always thread-safe.
- Fix: lazy double-checked singletons (`get_model`, `get_encoder`), decode prefetch pools that receive plain values.
- Prevent: new models follow the same singleton shape; inference stays on the pipeline thread.

**The same step could run twice on a trip (audit 2026-09-29, fixed same day, `pipeline/jobs.py`)**
- Symptom: reload mid-upload → "Upload to Drive" shown again → a second thread racing the first into duplicate person folders and shortcuts.
- Root cause: status-only guards; classify and upload write no in-progress status; no registry of running threads.
- Fix: every step starts through `jobs.start(step, trip_id, target, reset)`, which refuses (409) while that step's thread is alive; TripDetail re-attaches to running streams on mount.
- Prevent: no bare `threading.Thread(...).start()` for a pipeline step; the jobs table (stage 2) replaces this registry.

**A new subscriber read the previous run's "done" (audit 2026-09-29, fixed same day)**
- Symptom: retrying a failed step could close the progress stream on the old terminal event before the new thread wrote its first update, leaving a spinner with no stream (or the retry button back mid-run).
- Root cause: module-level progress dicts were never reset between runs.
- Fix: `jobs.start` resets the step's progress to `waiting` before the thread starts.
- Prevent: a run's first act is to claim its progress slot; clients treat `waiting` as "not started", never as "finished".

---

## 5. Photo routing & review logic

**Misc inflated by low-quality faces; dismissed-only photos vanished from Drive (found 2026-09-29, fixed same day, `1ef877a`)**
- Symptom: Misc 152 photos, only 67 reviewable; a photo whose faces were all dismissed got no shortcut anywhere.
- Root cause: "unmatched" computed in four places, none reading `is_low_quality`; no branch for "faces exist, none routable"; no scene label for face photos.
- Fix: one definition in `database/crud.py` (`routable_unmatched_face_filter`, `misc_photo_filter`, `places_photo_filter`); Places = no member and no routable face; planner dry-run showed 0 unrouted (`docs/BUGS.md` #12).
- Prevent: never hand-write `person_id IS NULL AND is_stranger = 0`; a new destination folder is added to `plan_trip_output` and the crud filters together and dry-run before touching Drive.

**The 314-misc-faces incident (2026-06-19, session 7)**
- Symptom: Misc queue jumped from 18 to 314 after a test cleanup.
- Root cause: `UPDATE face_observations SET is_stranger=0 WHERE person_id IS NULL` to undo a test dismissal also undid 296 real dismissals.
- Fix: user re-dismissed; no code change.
- Prevent: back up `registry.db` before any pipeline or test run (`sqlite3 registry.db ".backup '<path>'"`), and undo test actions by explicit IDs, never by a flag-wide UPDATE.

**Review queue shown one face at a time (2026-06-19, session 7; again 2026-09-29, `1ef877a`)**
- Symptom: the same stranger in 20 photos = 20 dismiss clicks; later, 66 cards of which 63 were bystanders.
- Root cause: review units were faces, not people.
- Fix: cluster Misc faces (`misc-clusters`, bulk assign/dismiss); then collapse clusters seen in fewer than 3 photos into Bystanders with one two-click Dismiss-all.
- Prevent: any new review surface groups by cluster and separates recurring from one-off before asking for clicks.

**Status whitelists too narrow (2026-06-18 session 5; 2026-06-19 session 7; 2026-09-29)**
- Symptom: 409 from `/enrollment/{id}/clusters` past `enrolled`; Gallery/Review gated on `uploaded`; classify refused on a `classified` trip.
- Root cause: hard-coded status tuples written for the happy path.
- Fix: widened each time; classify is idempotent so `classified` is allowed.
- Prevent: a guard lists the states in which the action is unsafe, not the one state it was designed for; write down why each state is excluded.

**Outfit-match Confirm is a dead end (found 2026-09-26, OPEN, parked)**
- Symptom: confirming an outfit match sets `UnmatchedPerson.status="assigned"` and nothing downstream reads it.
- Root cause: Phase 7 "create a FaceObservation on confirm" was never built.
- Prevent: body/outfit stage is parked until the core loop has real users; do not extend it.

**Returning friends get duplicate Person rows (found 2026-09-26, OPEN)**
- Symptom: Enroll never offers existing persons; "name once across trips" is only true for auto-matching.
- Root cause: `Enroll.tsx` only creates; `assign-faces` exists but is unused there.
- Prevent: stage 4 per-user registry adds an "existing person" picker; until then, Review's assign chips cover it.

**Per-person counts ignored the trip (found 2026-09-29, fixed same day)**
- Symptom: `GET /classify/{id}/results` and `GET /enrollment/{id}/persons` counted a person's faces/photos across every trip while the gallery counted per trip — a friend in two trips would show inflated numbers on the trip page and in Review.
- Root cause: `FaceObservation.person_id == X` with no join to `Photo.trip_id`.
- Fix: both queries join `Photo` and filter by trip.
- Prevent: any per-trip endpoint that counts faces or photos joins `Photo` and filters `trip_id`; the registry is global, counts never are.

**Global registry leaks across trips (found 2026-09-26, stage 4)**
- Symptom: `_match_faces` matches against every `PersonEmbedding` of every trip; `/api/persons/` lists all.
- Root cause: single-user design.
- Prevent: per-user scoping and API auth are stage-4 work; do not add cross-trip features before it.

**Re-ingestion not blocked (2026-06-18 GAP 4, OPEN)**
- Symptom: `POST /processing/{id}/ingest` on a classified trip would re-download and orphan face rows (API only, no UI path).
- Prevent: add the `created|failed` guard when the jobs table lands.

**Missing EXIF date makes outfit date "today" (found 2026-09-26, OPEN, parked)**
- Root cause: `pipeline/body.py` falls back to `datetime.now()`; `trips.timezone` is a dead column.
- Prevent: outfit day-grouping is parked with body detection.

**Our own `[Organized]` tree was re-ingested as source material (audit 2026-09-29, fixed same day)**
- Symptom: after an upload the source folder holds ~1700 shortcuts named like the photos; a re-ingest listed them (no md5/size → past every skip) and tried to download shortcuts, and the run's end reset the trip to `ingested`.
- Fix: `_list_files` skips `[Organized]` by name and by `output_folder_id`, and every shortcut; a re-ingest that adds nothing keeps the trip's status, new photos put it back at `ingested`.
- Prevent: whatever the app writes into the user's space is excluded from what it reads back, by identity, before the first re-ingest is attempted.

**Assign paths did not link the person to the trip (audit 2026-09-29, fixed same day)**
- Symptom: a gallery reassign or Review assign to a person not yet in `TripPerson` left them invisible in the gallery and unrouted in the plan.
- Fix: `crud.add_person_to_trip` on every path that sets `person_id`; bulk assign/dismiss act only on this trip's unassigned faces.
- Prevent: setting `person_id` and linking the person to the trip are one operation.

**Re-run guards written for the happy path, again (audit 2026-09-29, fixed same day)**
- Symptom: after an upload, the Re-run and Re-upload buttons the UI shows returned 409, and a re-run would have rolled the status back.
- Fix: classify accepts `uploaded`/`body_detected`, upload accepts `body_detected`, and both keep the current status when it is already past theirs.
- Prevent: a re-run never moves the status backwards; guards list the states where the action is unsafe.

---

## 6. React / UI

**Lazy images never load when hidden with display:none (2026-06, Phase 8)**
- Symptom: every grid thumbnail spun forever, zero network requests.
- Root cause: `loading="lazy"` skips elements outside layout flow.
- Fix: toggle `opacity`, keep the spinner as a sibling.
- Prevent: visibility of a lazy image is controlled by opacity, never `display`.

**Full-resolution photos used as grid tiles (2026-06, Phase 8)**
- Symptom: 13 tiles = 104 MB, multi-second loads on localhost.
- Root cause: `<img src>` pointed at the original.
- Fix: `GET /photos/{id}/thumbnail?w=480` (LANCZOS, EXIF-upright, JPEG q75, ~30 KB); full-res only in the lightbox.
- Prevent: grids use `api.photos.thumbnailUrl`; anything served as an `<img>` goes through `_thumbnail_jpeg()`.

**HEIC served as image/jpeg (2026-06-19 session 8; 2026-09-29 `8248150`)**
- Symptom: blank lightbox images, then a blank trip card once the top group photo was HEIC.
- Root cause: `FileResponse` of raw HEIC bytes with a JPEG content type.
- Fix: convert non-JPEG/PNG through PIL; cover and thumbnails share `_thumbnail_jpeg()`.
- Prevent: browsers cannot decode HEIC; every image endpoint either proves the suffix or converts.

**Request helper crashed on 204 (2026-06-19, session 6)**
- Symptom: `SyntaxError: Unexpected end of JSON input` after DELETE.
- Root cause: `res.json()` called unconditionally in `api/client.ts`.
- Fix: return `undefined` on 204 or `content-length: 0` in the helper.
- Prevent: fix response handling in the helper, never per call.

**Design tokens replaced by Tailwind approximations (2026-06-18, session 3–6)**
- Symptom: pills rendered as plain text, cards 200 px instead of 288, `rounded-xl` = 16 px in Tailwind v4, modals without blur or subtitle.
- Root cause: class names that look close to the spec are not the spec.
- Fix: explicit inline pixel values; `CreateTripModal` is the template for modals (`feedback_ui_css` memory).
- Prevent: use the token values from the design system; when a radius or size is specified, write the number.

**Inline elements do not stack under text-align:center (2026-06-19, session 8)**
- Symptom: sliders and a button side by side on wide screens.
- Root cause: `inline-block` + `inline-flex` inside a centred block.
- Fix: flex column wrapper.
- Prevent: stacking means `display:flex; flexDirection:column`.

**Effects and state resets (2026-06-18 session 4; 2026-09-27)**
- Symptom: keyboard listener re-registered every render; eslint `react-hooks/set-state-in-effect` errors.
- Root cause: missing dependency arrays; `useEffect(() => setX(...))` resets.
- Fix: dependency arrays; derive state (`loadedId === rep.face_id`) instead of resetting; helpers live in `src/lib/` because component files cannot export non-components.
- Prevent: no synchronous `setState` inside an effect; the two pre-existing errors (`client.ts` `any`, `Gallery.tsx`/`TripDetail.tsx` load effects) are known.

**Pipeline state shown from raw status instead of effective status (2026-06-18, session 4)**
- Symptom: a failed trip showed the wrong step as pending.
- Root cause: `pastUpload`/`pastBody` read `trip.status`, not `last_good_status` on failure.
- Fix: `effectiveStatus` in `TripDetail.tsx`.
- Prevent: any UI gate uses `effectiveStatus`.

**Carousel dots overflowed the panel (2026-06-19, session 7)**
- Symptom: 69 group photos × 13 px dots bled across the right panel.
- Root cause: one dot per item, no overflow handling.
- Fix: "N / total" counter past 10 items.
- Prevent: per-item indicators need a cap.

**Fake selected state in Confirmed panel (fixed 2026-09-29, `70f0a44`)**
- Symptom: the first person always looked selected.
- Root cause: design leftover `idx === 0`.
- Fix: rows are buttons that open the gallery on that person.
- Prevent: no hard-coded selected indices.

**Gallery lightbox overshoots the viewport, scroll goes to the page behind (found 2026-09-29, fixed same day)**
- Symptom: a portrait photo rendered 1547 px tall in an 813 px viewport; wheel scrolled the grid behind the fixed overlay.
- Root cause: the image container is a `flex: 1` item with default `min-height: auto`, so `maxHeight: 100%` resolved against the image itself; nothing locked body scroll.
- Fix: `minHeight: 0` on the photo column and image container, `overflow: hidden`, body scroll locked while open (`Gallery.tsx`).
- Prevent: any flex child that must bound an image gets `minHeight: 0`; overlays lock body scroll.

**Headless checks: innerText is the rendered text (2026-09-29)**
- Symptom: a wait for `innerText.includes('Bystanders')` never matched.
- Root cause: CSS `text-transform: uppercase` is reflected in `innerText`.
- Fix: wait on `textContent`; allow 60 s for Vite's first compile.
- Prevent: use `textContent` in CDP predicates; never click a writing action against the real DB.

**A held Enter key created a person twice (audit 2026-09-29, fixed same day)**
- Symptom: `saveName` had no in-flight guard and `onKeyDown` fires on auto-repeat → two "Alice" rows, duplicated embeddings, "Identified 7 / 6".
- Fix: return early while the cluster is in `saving`; key handlers ignore `e.repeat`.
- Prevent: every mutating handler checks its in-flight set first; keyboard submit handlers ignore repeats.

**Session state keyed by per-run cluster ids (audit 2026-09-29, fixed same day)**
- Symptom: Remove refetched clusters, the agglomerative labels were renumbered, and `savedNames`/`dismissed` keyed by the old ids mislabelled faces or hid clusters as "already named".
- Fix: reset keyed state after the refetch (the server already excludes named and dismissed faces).
- Prevent: never key UI state by a value the backend regenerates per request; use a stable id or reset on refetch.

**Action failures replaced the page; no re-attach after a reload (audit 2026-09-29, fixed same day)**
- Symptom: a 409 from a step button rendered the full-screen "trip not found" view; reloading mid-run showed a spinner with no stream, or the start button again.
- Fix: separate `actionError` banner; on mount subscribe to the stream matching an in-progress status and probe the classify/upload streams (first event `running` → attached, else closed); closers stored and called on unmount.
- Prevent: load errors and action errors are different states; every SSE subscription's closer is kept and called on unmount.

**Queue index went negative after the last item (audit 2026-09-29, fixed same day)**
- Symptom: Verify These rendered nothing after clearing the queue and re-running (`list[-1]`).
- Fix: clamp with `Math.max(0, …)` and reset to 0 on refetch.
- Prevent: any index into a list that shrinks is clamped at both ends.

**Home card showed a resting `classified` trip as processing (audit 2026-09-29, fixed same day)**
- Symptom: the flagship trip's card was dimmed with an indeterminate bar and a pulsing pill.
- Root cause: a status set copied from a sketch included `classified`.
- Prevent: the processing set contains only statuses a pipeline writes while running (`ingesting`, `extracting_faces`, `body_detecting`).

---

## 7. Process & workflow

**Verify the hypothesis before editing (recurring)**
- Symptom: fixes proposed for a wrong JWT algorithm, a non-existent column, a PATH that worked; here, "MPS segfaults" and "700 MB of weights" were both stale.
- Root cause: acting on plausible memory instead of the live system.
- Fix: state the root-cause sentence, run the one command that confirms it (schema, env var, probe script), then edit.
- Prevent: any fact a change depends on is re-read from disk or the running system in the same session.

**Enumerate every instance before patching (2026-09-29 and earlier)**
- Symptom: three bad columns, one removed; four "unmatched" definitions, one fixed at a time.
- Fix: grep for all call sites / definitions first, fix in one pass, replace copies with one helper.
- Prevent: a class of bug is closed by a shared definition, not by patching the instance that was noticed.

**Read the whole error, work backwards from the symptom**
- Symptom: the first line of a traceback pattern-matched to a familiar cause (ORM IndexError looked like bad data).
- Prevent: read the full trace, follow the data path from the observable symptom; the cyextension frame said "thread", not "data".

**Re-probe stale environment claims (2026-07-03)**
- Symptom: "YOLO on MPS segfaults" was true for yolov8/older torch, false for YOLO11/torch 2.12 (3× faster on MPS); the FAISS conflict vanished with FAISS.
- Prevent: any "X crashes on this machine" note involving an upgraded dependency gets a 60-second probe in a disposable subprocess before design decisions.

**Measure, then write the number down**
- Symptom: claims like "fully functional" while v2 had never run past enrollment on real data.
- Fix: before/after counts for every pipeline change in `docs/CHANGELOG-v2.md`; `compare_bgr.py`-style A/B scripts.
- Prevent: a change without a measured number on the real trip is "written, not verified" and is reported as such.

**Never run pipelines under an open tab; back up the DB first**
- Symptom: stale IDs in the UI; the 314-faces cleanup.
- Prevent: `sqlite3 registry.db ".backup"` before any run; face re-runs only when Prem is not in the UI; test actions undone by ID.

**Commit and push after a verified fix**
- Symptom: verified work left local is not deployed and gets lost across sessions.
- Prevent: conventional commit + push on the release branch as the last step of every fix.

**Machine quirks that cost time (macOS, zsh)**
- Symptom: no `timeout` command; unquoted globs abort the command line; `PIPESTATUS` is `pipestatus`; `sed -i ''`; stale uvicorn on :8000 serving old code; `.zshenv` noise lines; POST to `/api/trips` 307s without the trailing slash.
- Prevent: `env_workflow_notes` memory before driving the backend from the CLI; `lsof -t -i :8000 -i :5173 | xargs kill` before a fresh start.

**Thresholds are named constants and tuned on real data**
- Symptom: eps tuned on 51 photos failed at 1096.
- Prevent: every threshold is a module-top constant listed in `docs/CHANGELOG-v2.md`; changes cite the trip they were tuned on.

**Keep the private notes current**
- Symptom: comments saying "eps=0.6 tuned on this dataset" after the change; README claiming completeness.
- Prevent: `docs/BUGS.md` entry for every non-trivial bug, changelog section per feature, memory pointer per session; stale claims are deleted, not annotated.

---

## Checklist before adding …

**a pipeline step**
- Load images through the shared loader (EXIF-upright, ≤ 1920 long side, `pillow_heif` registered); state the coordinate space of every number you store.
- Snapshot plain values before any thread pool; commit per batch; run it on the real trip and write the counts down.
- Define idempotency explicitly: what is kept, what is replaced, how survivors are matched.
- Status changes only through `crud.update_trip_status`; progress via the trip row (jobs table later), not a new dict.

**an ML library or model**
- Check for a bundled `libomp`; probe crash claims in a subprocess; probe input size, channel order, output dim and norm.
- Disable sub-models nothing reads; keep one lazy singleton; keep thresholds as named constants tuned on real data.

**an endpoint**
- Convert numpy scalars; cast DB coordinates to `int`; return real JPEG for anything a browser will render.
- Reuse the crud routing filters for anything about Misc/Places/unmatched; write a `UserCorrection` for anything that moves a face.
- Guard states by what is unsafe, not by the happy-path state; 204 responses are handled by the request helper.

**a UI overlay or lightbox**
- Coordinates: divide by the detection scale or use served `det_width/det_height`.
- Flex children that bound an image get `minHeight: 0`; overlays lock body scroll; lazy images toggle opacity.
- Explicit token values, no Tailwind approximations; no `setState` inside effects; helpers in `src/lib/`.
- Verify headlessly with `textContent` predicates and never click a writing action on the real DB.

**a background step**
- Start it through `pipeline/jobs.start` (refuses a duplicate run, resets progress); write status only via `crud.update_trip_status`, and never move it backwards on a re-run.
- Define the second run before the first: what survives, what is replaced, what happens to rows with a user decision; test the second run against a stub.
- Report failures in the done payload; the UI re-attaches to a running stream on mount.

**a write to the user's Drive (or any external system)**
- Retries on every call, escaped query literals, one service per thread.
- Reconcile both ways on re-run (create missing, delete extra) and never read your own output back as input.
- Plan from the DB in a pure function, dry-run it, then execute.

**a DB column or table**
- Add it to the model and rely on the startup `ensure_columns`; check `.schema` after restart.
- New `trip_id` FK → add to the pre-delete block in `api/trips.py`; composite-PK links are deleted with raw SQL.
- Never bulk-UPDATE a flag to undo a test; back up `registry.db` first.
