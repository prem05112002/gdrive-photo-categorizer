# v2 Pipeline Optimization — 2026-07-03

Full-pipeline speed + accuracy overhaul. Five commits on `v2`:

| Commit | Scope |
|---|---|
| `74b6c01` | Parallel Drive ingestion |
| `b579e53` | Face quality gate + two-stage clustering + Enroll UX |
| `13e57ba` | FAISS removed; SigLIP 2 scene classification |
| `7122ab1` | Body detection: YOLO11 + outfit embeddings, in-process |
| `859a123` | Parallel Drive shortcut upload |

**Breaking:** the DB schema changed (columns added/renamed) and `registry.db` was wiped as part of this upgrade. There is no migration — re-ingest trips from scratch. The re-ingestion resume guard makes this cheap.

---

## 1. Ingestion (`backend/drive/ingest.py`)

**Problem:** ~1100 photos took far too long. The loop was strictly sequential — one HTTP download at a time, plus a SQLite commit (fsync) per photo.

**Changes:**
- Downloads run in a **12-thread pool**; each worker holds its own Drive service (`googleapiclient` service objects are not thread-safe).
- `files.list` now requests `md5Checksum` + `size`. **Exact duplicates are detected before download** and never fetched; pHash still catches near-duplicates (bursts, re-compressions) after download.
- DB writes happen only on the coordinator thread, **committed in batches of 50**.
- **Resume guard:** files whose `drive_file_id` already exists with a live local file (or a duplicate row) are skipped — a crashed/interrupted ingest continues instead of restarting.
- Per-file failures increment `failed_count` and continue instead of aborting the trip.
- pHash + EXIF extracted with a **single image decode** (was two).
- Local filenames are prefixed with the Drive file ID — two cameras both producing `IMG_0001.JPG` no longer clobber each other.

**Schema:** `photos.md5_checksum` added.

---

## 2. Face pipeline (`backend/pipeline/face.py`)

**Problem:** every detected face — blurry backgrounds, tiny bystanders — went into clustering and eventually into the review queue.

**Changes:**
- **Quality gate** per face: `det_score < 0.65`, face smaller than 40 px (detection space), or Laplacian blur variance < 45 → flagged `is_low_quality`. These faces are stored (for gallery display) but **hidden from enrollment**; they are still auto-matched later during classification.
- **Decode prefetch:** a 4-thread pool decodes/resizes images ahead of the detector, so inference never waits on I/O.
- Commits batched (25 photos); re-running the pipeline first deletes unassigned observations from earlier runs (**idempotent**).
- `pillow_heif` registered at module level — HEIC face detection no longer depends on another module importing first.

**Schema:** `face_observations.blur_score`, `face_observations.is_low_quality` added.

**Follow-up (2026-09-27):**
- **RGB→BGR fix.** `_load_image` yields RGB (PIL), but InsightFace's model zoo is written for cv2 input and swaps channels itself (`swapRB=True` in both `retinaface.py` and `arcface_onnx.py`), so the detector and ArcFace were seeing swapped channels. Now `cv2.cvtColor(img, COLOR_RGB2BGR)` is applied for the model only; face crops and blur scores stay RGB. Measured on the Kochi trip (1139 photos): the six dominant people clustered as `209/144/125/111/92/92` faces plus `32/23`-face fragments before, `220/147/129/125/122/117` after with the next cluster at 11 — same intra-cluster cosine (≈0.68) at larger sizes, 27 → 16 suggested singletons. Faces detected 1291 → 1327 (the detector input changed too).
- **`allowed_modules=["detection", "recognition"]`** — the 3d68/2d106 landmark and gender/age sub-models were loaded and run on every face for nothing (~30% CPU time, ~150 MB of weights). Nothing reads their outputs.
- `crud.update_trip_status` now clears `error_message` on any non-failed transition, so a trip that recovered from a crash no longer carries the stale failure text.
- **EXIF orientation applied before detection** (`_load_image`, and `utils/image.open_for_processing` + `scene.py` for consistency). 155 of the 1139 Kochi photos are phone JPEGs stored sideways with an orientation tag; the detector was seeing them rotated. On those photos alone: 109 faces (85 passing the quality gate) before vs 171 (167 passing) after. Whole trip: 1327 → 1389 faces, low-quality 282 → 263, group photos 70 → 81, main clusters `240/160/148/139/135/128`. Detection space is now the *upright* image (long side ≤1920), which is also what browsers show and what `api/body.py` and the gallery overlay already assumed — stored bboxes for rotated photos were previously in the wrong space.

---

## 2b. Enroll page redesign (2026-09-27)

**Problem:** naming a cluster from three 44px crops was guesswork, and the "Group photos" panel showed disembodied face crops with nothing to do.

**Changes:**
- **Reference photos** (left, 400px): the actual group photo (`/thumbnail?w=800`) with every detected face boxed. Boxes are positioned as percentages of the detection-space size (`det_width`/`det_height` from the API), so no image measuring. Click a face → the roster scrolls to and flashes its cluster; named faces get a green label, so the photo fills in as you enroll. Expand button opens the same view large.
- **Cluster cards:** one 128px hero crop + up to five 56px samples chosen best-first and **spread across different photos** (`_pick_representatives`), plus "N faces in M photos". Any crop opens the **face-in-context lightbox**.
- **Face-in-context lightbox:** `GET /api/photos/{photo}/face/{face}/context?w=` crops ~3 face-widths around the box from the original (EXIF-upright), outlines the face, and the modal lets you flip through the samples and name the person right there.
- Endpoints: `GET /enrollment/{trip}/group-photos` now returns `det_width/det_height` and `faces[]` (bbox, person_id/name, quality flags) instead of six crops; `GET /enrollment/{trip}/clusters` returns `representatives[]` (face_id, photo_id, file_name, bbox, crop) and `photo_count`. `representative_crops` is still produced for the Review page's Misc clusters.

---

## 3. Clustering (`backend/enrollment/cluster.py`)

**Problem:** DBSCAN with `min_samples=1` has no noise concept — every odd pose/lighting variant became its own singleton cluster (the 314-misc-faces incident).

**Changes — two-stage clustering:**
1. **Agglomerative** (average linkage, cosine, distance ≤ 0.45) forms high-precision cores.
2. **Singleton attachment:** each leftover face is compared to every core's top-5 most-confident embeddings:
   - max-sim ≥ **0.50** → auto-merged into the cluster
   - **0.38–0.50** → kept as singleton with `suggested_cluster_id` (renders as a one-tap "Might be X ✓" chip)
   - below → plain singleton (likely stranger)

**API:** clusters response gains `suggested_cluster_id` per cluster and a top-level `low_quality_count`. New endpoint `POST /enrollment/{trip_id}/assign-faces` assigns faces to an existing person (also saves their embeddings and links `TripPerson`).

**UI (`Enroll.tsx`):** singletons collapsed into a **"Needs review" accordion** (default closed, count badge); suggested faces sort first with a confirm chip once the target cluster has been named; hidden low-quality count is shown as a footnote.

---

## 4. Classification (`backend/pipeline/classify.py`)

**Problem:** FAISS was overkill for a few-hundred-vector registry, and its bundled `libomp.dylib` segfaulted against PyTorch's on macOS ARM64 — which forced scene classification (and body detection) into subprocess workers with JSON-over-stdout progress plumbing.

**Changes:**
- FAISS **deleted** (also uninstalled, removed from `requirements.txt`). Matching is one numpy matmul — exact, instant, no OMP conflict. Both subprocess workers (`scene_classify_worker.py`, `body_detect_worker.py`) are gone; everything runs in-process.
- **Margin rule:** a face is assigned only if the best person's similarity ≥ **0.50** *and* it beats the runner-up person by ≥ **0.10** (per-person max over all enrolled embeddings). Guards against lookalikes/siblings.
- All unassigned faces are matched in a single batched matmul instead of a Python loop.

---

## 5. Scene classification (`backend/pipeline/scene.py` — new module)

**Problem:** 2021-era OpenAI CLIP ViT-B/32, one image at a time, CPU-only, in a subprocess. `"a photo of other"` was a real prompt.

**Changes:**
- **SigLIP 2 ViT-B/16** (`open_clip`, `webli` weights, needs `transformers`) on **MPS**, batch 16, with a 4-thread decode pool. Warm throughput ~11 ms/photo (was ~1 s).
- **Prompt ensembles** per label (3 phrasings, averaged text embeddings).
- `"other"` is assigned via a **confidence floor** (softmax < 0.30), never predicted directly.
- Label vocabulary unchanged (`beach … food`, `other`) — gallery scene reassignment and Drive `Places/` output are unaffected.
- `get_encoder()` exposes the model as a lazy singleton — shared with body detection for outfit embeddings.

---

## 6. Body detection (`backend/pipeline/body.py`)

**Problem:** `yolov8x-seg` on CPU (~1.8 s/photo), full-resolution input, HSV histograms for outfit matching, first-face-center-hit association — and a **silent coordinate-space bug**: body boxes were in original-image pixels while face bboxes are stored in 1920-long-side detection space, so face↔body association quietly failed for photos wider than 1920 px.

**Changes:**
- **YOLO11m-seg on MPS** (~30 ms/photo warm; the old "MPS segfaults" note was re-probed on torch 2.12 and no longer reproduces). CPU fallback if MPS is unavailable.
- Detection input is the same **1920-long-side PIL-loaded image** as the face pipeline: one shared coordinate space, and HEIC now works (cv2 returns `None` for HEIC).
- **Outfit re-ID:** HSV histograms → **SigLIP 2 embeddings of the masked person crop** (background neutralized to gray). Robust to lighting changes; shares the scene encoder singleton.
- **Association:** the enrolled face with the highest containment fraction (≥ 0.6) inside the body box wins — was "first face whose center falls in the box", which grabbed the wrong person in tight group shots.
- Re-runs clear `pending_review` detections first (idempotent). Runs in-process; subprocess worker deleted.
- `api/body.py`: misclassification detection moved to the same embedding space (defaults: similarity 0.60, margin 0.08); body-crop endpoint converts detection-space → original-space coordinates.

**Schema:** `person_outfits.hsv_histogram` → `outfit_embedding`; `unmatched_persons.hsv_histogram` → `outfit_embedding` (both now SigLIP2 float32 vectors, L2-normalized).

---

## 7. Drive upload (`backend/drive/output.py`)

**Problem:** every shortcut cost two sequential HTTP round-trips (existence-check `list` + `create`) — thousands of serial calls per trip.

**Changes:**
- The full shortcut worklist is **planned from the DB first**, then executed by a **10-thread pool** (per-thread Drive services).
- Existence checks are **skipped when `[Organized]` was newly created** (a fresh tree cannot collide); re-runs into an existing tree keep the idempotent get-or-create path.
- Per-shortcut failures are logged and skipped instead of aborting the upload.

---

## Tuning knobs (named constants, all at module top)

| Constant | Value | File | Effect if raised |
|---|---|---|---|
| `MIN_DET_SCORE` | 0.65 | `pipeline/face.py` | more faces hidden as low-quality |
| `MIN_FACE_SIZE` | 40 px | `pipeline/face.py` | more small faces hidden |
| `MIN_BLUR_VAR` | 45 | `pipeline/face.py` | more soft/blurry faces hidden |
| `CLUSTER_DISTANCE_THRESHOLD` | 0.45 | `enrollment/cluster.py` | looser clusters (merge risk) |
| `ATTACH_SIM` | 0.50 | `enrollment/cluster.py` | fewer auto-attachments |
| `SUGGEST_SIM` | 0.38 | `enrollment/cluster.py` | fewer suggestion chips |
| `MATCH_THRESHOLD` / `MATCH_MARGIN` | 0.50 / 0.10 | `pipeline/classify.py` | stricter auto-assignment |
| `MIN_CONFIDENCE` | 0.30 | `pipeline/scene.py` | more photos labeled "other" |
| `OUTFIT_SIMILARITY_THRESHOLD` | 0.60 | `pipeline/body.py` | fewer outfit suggestions |
| `MIN_FACE_CONTAINMENT` | 0.60 | `pipeline/body.py` | stricter face↔body pairing |
| `DOWNLOAD_WORKERS` / `UPLOAD_WORKERS` | 12 / 10 | `drive/ingest.py` / `drive/output.py` | more Drive parallelism |

These defaults were validated on synthetic data and probes, not yet on a full real trip — expect one tuning pass after the first end-to-end run.

## Removed

- `backend/pipeline/scene_classify_worker.py`, `backend/pipeline/body_detect_worker.py` (subprocess isolation obsolete)
- `faiss-cpu` dependency; `backend/yolov8x-seg.pt` (replaced by auto-downloaded `yolo11m-seg.pt`)

## Added dependencies

- `transformers` (SigLIP2 tokenizer backend), `ultralytics` (now pinned in `requirements.txt` — previously used but undeclared)
