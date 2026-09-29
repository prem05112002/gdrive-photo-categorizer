# Google Drive Photo Categorizer

A local web app that takes a Google Drive folder full of trip photos, runs face recognition and scene classification, lets you name each person in the photos, and writes back an organized `[Organized]/` folder structure directly into your Drive — with subfolders per person, per scene, and for RAW files — all using Drive shortcuts (no re-uploading, no copies).

---

## How it works — end to end

```
Google Drive folder
        │
        ▼
  1. INGEST          Download all photos in parallel (12 workers). Exact
                     duplicates caught via Drive md5 before download; near-
                     duplicates via pHash. RAW and videos flagged separately.
                     Interrupted runs resume where they left off.
        │
        ▼
  2. FACE PIPELINE   Run InsightFace buffalo_l on every standard image.
                     Extract 512-dim face embeddings + face crop thumbnails.
                     Quality-gate each face (size, sharpness, confidence) —
                     junk faces never reach review. Flag group photos (≥ 5 faces).
        │
        ▼
  3. ENROLLMENT      Two-stage clustering: agglomerative cores + singleton
                     attachment with "might be X" suggestions. You name each
                     cluster in the UI (or dismiss strangers). Embeddings are
                     saved to the registry.
        │
        ▼
  4. CLASSIFY        Remaining unassigned faces matched against the registry
                     (cosine similarity with a lookalike margin rule).
                     Photos with no faces get a scene label via SigLIP 2.
        │
        ▼
  5. BODY DETECT     YOLO11m-seg detects full-body person silhouettes.
                     SigLIP 2 outfit embeddings link bodies (without visible
                     faces) to enrolled persons.
        │
        ▼
  6. REVIEW          Browse all persons, scenes, and unresolved faces.
                     Reassign or dismiss any misclassifications.
        │
        ▼
  7. UPLOAD          Creates [Organized]/ in your Drive with shortcuts:
                     Person/  Places/beach/  Places/temple/  RAW/  Misc/
```

All photo data is stored locally in SQLite. Nothing is uploaded to any cloud except the Drive shortcuts at the very end (and those point to files you already own — nothing is copied or re-uploaded).

---

## Models

### 1. InsightFace — `buffalo_l`
**Task:** Face detection + 512-dim face embedding extraction  
**Where used:** Face pipeline (step 2)  
**Downloaded automatically** on first run (~235 MB from the InsightFace CDN, cached in `~/.insightface/`)

`buffalo_l` is a two-stage pipeline:
- **RetinaFace** detector: finds every face and returns bounding boxes + 5-point landmarks
- **ArcFace** recognizer: aligns the crop and encodes it into a 512-dimensional L2-normalised embedding

On Apple Silicon Macs, the ONNX runtime uses **CoreML** (`MLComputeUnits: ALL`) to accelerate both stages on ANE/GPU. On other systems it falls back to CPU.

---

### 2. Face quality gate
**Task:** Keep unreliable faces out of enrollment  
**Where used:** Face pipeline (step 2)

Every detected face is scored before it can reach clustering. A face is flagged `is_low_quality` if any of:

| Check | Threshold |
|---|---|
| Detector confidence (`det_score`) | < 0.65 |
| Face size (detection space) | < 40 px |
| Sharpness (Laplacian variance of the crop) | < 45 |

Low-quality faces are stored (they still render in the gallery) but are hidden from the enrollment review queue — they get matched automatically during classification instead. This is the main fix for the "hundreds of singletons to review" problem. They also never route a photo: a photo whose only unmatched faces are low-quality goes to its members' folders, or to Places by scene if nobody named is in it — never to Misc.

---

### 3. Two-stage face clustering (scikit-learn Agglomerative)
**Task:** Unsupervised face clustering  
**Where used:** Enrollment step (step 3)

**Stage 1 — cores:** agglomerative clustering (average linkage, cosine distance ≤ 0.45) over quality-passing embeddings. High precision: a core cluster is virtually never two different people.

**Stage 2 — singleton attachment:** each face left alone by stage 1 (odd pose, sunglasses, occlusion) is compared against every core's top-5 most-confident embeddings:

| Max similarity | Outcome |
|---|---|
| ≥ 0.50 | auto-merged into the cluster |
| 0.38 – 0.50 | kept as singleton with a "Might be X ✓" suggestion chip in the UI |
| < 0.38 | plain singleton (likely stranger, collapsed by default) |

Clusters are sorted by size and presented for naming. Replaced DBSCAN(`eps=0.35, min_samples=1`), which turned every noise point into a review item.

---

### 4. Registry face matching (numpy)
**Task:** Match unassigned faces against the enrolled person registry  
**Where used:** Classify step (step 4)

All embeddings are L2-normalized, so matching is a single `faces @ registry.T` matmul — exact cosine similarity for the whole trip at once. A face is assigned only if:
- best person similarity ≥ **0.50**, and
- it beats the **runner-up person by ≥ 0.10** (margin rule — guards against lookalikes/siblings)

This replaced FAISS: at registry scale (hundreds of vectors) brute-force numpy is just as exact and instant, and removing FAISS eliminated the `libomp` SIGSEGV that previously forced scene classification and body detection into subprocess workers.

---

### 5. SigLIP 2 — `ViT-B-16` (open_clip, `webli` weights)
**Task:** Zero-shot scene classification + outfit embeddings  
**Where used:** Classify step (step 4) and body detection (step 5), in-process  
**Downloaded automatically** on first run (~440 MB, cached by HuggingFace)

Runs on Apple Silicon via **MPS** in batches of 16 (~11 ms/photo warm). Each scene label uses a **prompt ensemble** (three phrasings, averaged text embeddings). `other` is never predicted directly — it's assigned when the top softmax confidence falls below 0.30.

Scene labels used:

| Label | Label | Label | Label | Label |
|---|---|---|---|---|
| beach | mountain | temple | monument | street |
| market | nature | indoor | food | other |

The same encoder (a shared lazy singleton, `pipeline/scene.py:get_encoder`) also embeds masked person crops for outfit re-identification.

---

### 6. YOLO11m-seg (Ultralytics)
**Task:** Full-body person detection with instance segmentation masks  
**Where used:** Body detection step (step 5), in-process  
**Model file:** `backend/yolo11m-seg.pt` — downloaded automatically on first run (~45 MB)

Runs on every photo with `conf=0.35`, class 0 (person only), on **MPS** (~30 ms/photo warm; falls back to CPU). Detection runs on the same 1920-long-side image as the face pipeline, so body boxes and face bboxes share one coordinate space, and HEIC photos work (loaded via PIL, not cv2).

---

### 7. Outfit re-identification (SigLIP 2 embeddings)
**Task:** Outfit fingerprinting and body-to-person matching  
**Where used:** Body detection step (step 5)

For each detected body, the person crop is masked (background neutralized to gray) and embedded with SigLIP 2. That vector is the "outfit signature" for that person on that day — robust to lighting shifts, unlike the HSV colour histograms it replaced.

Two uses:
1. **Face-linked bodies:** the enrolled face with the highest containment fraction (≥ 0.6) inside the body box claims it; the embedding is running-averaged into that person's `PersonOutfit` record for the trip date.
2. **Unmatched bodies:** compared against all enrolled outfit embeddings by cosine similarity. Matches ≥ 0.60 are suggested as that person (surfaces in the Review tab for confirmation).

---

## Project structure

```
.
├── backend/
│   ├── api/                  FastAPI route handlers
│   ├── database/             SQLAlchemy models, CRUD helpers, schema
│   ├── drive/                Google Drive auth + download + shortcut upload
│   ├── enrollment/           Two-stage face clustering + enrollment router
│   ├── pipeline/             Face, scene, and body detection pipelines (all in-process)
│   │   ├── face.py           InsightFace runner + quality gate
│   │   ├── classify.py       numpy registry matcher + classify orchestration
│   │   ├── scene.py          SigLIP 2 scene classifier + shared encoder singleton
│   │   └── body.py           YOLO11-seg + SigLIP 2 outfit re-ID
│   ├── utils/image.py        pHash, EXIF, HEIC support, file-type detection
│   ├── main.py               FastAPI app entrypoint
│   ├── requirements.txt
│   ├── .env.example
│   └── credentials.json      ← you provide this (not committed)
├── frontend/
│   └── src/
│       ├── pages/            Home, TripDetail, Enroll, Review, Gallery
│       └── components/       TripCard, Topbar, StatusPill, modals
├── scripts/
│   └── clear_drive_output.py  Dev utility: remove [Organized]/ from Drive
├── start.sh                  One-command launcher
└── README.md
```

---

## Supported file formats

| Type | Extensions |
|---|---|
| JPEG | `.jpg` `.jpeg` |
| PNG | `.png` |
| HEIC / HEIF (iPhone) | `.heic` `.heif` |
| TIFF | `.tiff` `.tif` |
| RAW (Canon, Sony, Nikon, Fuji, Olympus, Pentax, Leica…) | `.cr2` `.cr3` `.arw` `.nef` `.orf` `.raf` `.dng` `.rw2` `.pef` `.3fr` `.erf` |
| Video (downloaded, not processed) | `.mp4` `.mov` `.avi` `.mkv` `.m4v` `.3gp` `.mts` `.m2ts` `.wmv` `.hevc` |

RAW files and videos are downloaded and placed in a `RAW/` or `Videos/` shortcut folder but are not run through any ML pipeline.

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Python | 3.11 or 3.12 recommended (3.14 works, some warnings) | `python3 --version` |
| pip | bundled with Python | `pip --version` |
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |
| Git | any | `git --version` |

**macOS:** Tested on Apple Silicon (M2 Pro). Intel Macs work but won't use CoreML acceleration.  
**Linux:** Should work. MPS acceleration is macOS-only; SigLIP 2 and YOLO fall back to CPU (or CUDA if you adapt the device selection).  
**Windows:** Untested. The `start.sh` launcher won't work; run backend and frontend manually (see below).

Optional (macOS, for HEIC support):
```bash
brew install libheif
```

---

## Setup

### Step 1 — Clone the repo

```bash
git clone <repo-url>
cd google-drive-photo-categorizer
```

---

### Step 2 — Google Cloud credentials

The app needs OAuth 2.0 credentials to access your Google Drive. This is a one-time setup.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (e.g. `photo-categorizer`).

2. Enable the Drive API:  
   **APIs & Services → Library → search "Google Drive API" → Enable**

3. Create OAuth credentials:  
   **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Desktop app**
   - Name: anything (e.g. `photo-categorizer-local`)

4. Download the JSON file, rename it to `credentials.json`, and place it at:
   ```
   backend/credentials.json
   ```

5. Configure the consent screen:  
   **APIs & Services → OAuth consent screen**
   - User type: **External**
   - Under **Test users**, add the Google account that owns the Drive folders you want to process.

The first time you run the app, a browser tab opens for Google sign-in. After you approve, a `token.json` is saved in `backend/` and reused on all future runs (no re-auth needed).

---

### Step 3 — Python virtual environment

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

This installs all Python dependencies including PyTorch, InsightFace, OpenCLIP (+ transformers for the SigLIP 2 tokenizer), Ultralytics, and the Google Drive client library.

> **First run note:** On the very first pipeline run, the following models are downloaded automatically:
> - `buffalo_l` (InsightFace) — ~235 MB → `~/.insightface/models/buffalo_l/`
> - `ViT-B-16-SigLIP2` (open_clip) — ~440 MB → `~/.cache/huggingface/`
> - `yolo11m-seg.pt` (Ultralytics) — ~45 MB → `backend/yolo11m-seg.pt`

---

### Step 4 — Frontend dependencies

```bash
cd frontend
npm install
```

---

## Running

### Option A — One command (recommended)

From the project root:

```bash
./start.sh
```

Starts both servers, prints their URLs, and shuts both down on `Ctrl+C`.

---

### Option B — Two terminals

**Terminal 1 — Backend:**
```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
```

---

### Access the app

| Server | URL |
|---|---|
| App (React UI) | http://localhost:5173 |
| API (FastAPI) | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |

Open **http://localhost:5173** — that's the only URL you need to use.

---

## Using the app

1. **Create a trip** — give it a name and paste your Google Drive folder URL (or bare folder ID). The folder can be a shared album or any folder you have access to.

2. **Ingest** — the app downloads all photos 12-wide in parallel, skips exact duplicates before downloading (Drive md5), detects near-duplicates (perceptual hash), and catalogues RAW files and videos. If the run is interrupted, re-running resumes where it stopped.

3. **Run face pipeline** — InsightFace scans every standard image while the next images decode in the background. Blurry/tiny/uncertain faces are quality-gated out of review automatically.

4. **Enroll people** — clusters of similar faces are shown. Type a name for each cluster. One-off faces live in a collapsed "Needs review" section; faces that look like an already-named member show a one-tap "Might be X ✓" chip. Dismiss strangers you don't want to track.

5. **Classify** — remaining faces are matched to your enrolled registry (with a lookalike margin rule). SigLIP 2 labels every photo by scene; photos with nobody named in them are filed under Places.

6. **Body detection** (optional but recommended) — YOLO11 finds people in every photo using full-body detection and matches them to enrolled members by outfit embedding. Useful for photos where faces are obscured or too small to detect.

7. **Review** — check the Persons tab (face counts per person), the Gallery tab (browse by scene), and the Misc Faces tab (faces that couldn't be auto-matched: anyone seen in 3+ photos gets a card, one-off bystanders collapse into a single Dismiss-all). Reassign or dismiss any errors.

8. **Upload to Drive** — creates `[Organized]/` inside your source folder. Shortcuts (not copies) are organized by person name, scene label, and RAW. Original files are never touched.

---

## Files created at runtime

| Path | Contents | Safe to delete? |
|---|---|---|
| `backend/registry.db` | SQLite — persons, trips, photos, face observations | Deleting resets everything |
| `backend/token.json` | Cached Google OAuth token | Yes — triggers re-auth on next start |
| `backend/temp/<trip-id>/` | Downloaded photos for a trip | Yes, after the trip is uploaded to Drive |
| `backend/temp/<trip-id>/raw/` | RAW files | Yes, once you've confirmed you don't need them locally |
| `backend/temp/<trip-id>/videos/` | Video files | Yes |
| `backend/yolo11m-seg.pt` | YOLO11m-seg model weights | No — re-downloaded on next body detection run |
| `~/.insightface/models/buffalo_l/` | InsightFace model files | No — re-downloaded on next face pipeline run |

---

## Troubleshooting

**`credentials.json not found`**  
→ Complete Step 2 above. The file must be at `backend/credentials.json` exactly.

**`ModuleNotFoundError: No module named 'fastapi'` (or similar)**  
→ Your venv is not active. Run `source backend/.venv/bin/activate` before starting the backend.

**Frontend shows blank page / "cannot reach API"**  
→ Confirm the backend is running: open `http://localhost:8000/api/health` — it should return `{"status":"ok"}`.

**Drive listing returns 0 files**  
→ The folder must be accessible to the Google account you authenticated with. Either own the folder or have it shared with that account.

**HEIC files fail to open**  
→ `pillow-heif` requires `libheif`. On macOS: `brew install libheif` then `pip install --force-reinstall pillow-heif`.

**Body detection crashes immediately**  
→ Ensure `yolo11m-seg.pt` is in `backend/` (it auto-downloads on first run; if the download was interrupted, delete the partial file and try again).

**Face pipeline is very slow**  
→ On non-Apple-Silicon systems, InsightFace runs on CPU only. A 500-photo trip can take 30–60 minutes. On M-series Macs with CoreML, the same trip takes 5–15 minutes.

**`invalid_grant: Token has been expired or revoked`**  
→ Your cached OAuth token died (Google expires tokens for consent screens left in "Testing" mode after 7 days). Delete `backend/token.json` and re-run — a consent window opens on the next Drive call. To stop this recurring, publish the OAuth consent screen (Cloud Console → OAuth consent screen → Publish app).

**`SIGSEGV` or segfault during classification or body detection**  
→ Historical issue: FAISS and PyTorch each bundled their own `libomp` and crashed when loaded together on macOS ARM64. FAISS was removed in v2, so everything now runs in one process. If you still see a segfault, open an issue with your Python version and OS.

---

## Architecture notes

- **No cloud dependency beyond Google Drive** — all models run locally, all data stays on your machine.
- **Person registry is global** — persons you enroll in one trip are available to auto-match in future trips. The same person traveling in two separate trips only needs to be named once.
- **Single process** — face matching is plain numpy, so PyTorch (SigLIP 2, YOLO11) runs safely in the main process. The old FAISS/PyTorch `libomp` conflict and its subprocess workers are gone.
- **One coordinate space** — face and body bounding boxes are both stored in 1920-long-side detection space; anything rendering onto the original image applies one scale factor.
- **One encoder, three jobs** — a single shared SigLIP 2 instance handles scene labels, outfit fingerprints, and misclassification checks.
- **Shortcuts, not copies** — the Drive upload step creates `application/vnd.google-apps.shortcut` files, so every photo appears in person and scene folders without consuming additional Drive storage.
- **Resumable by design** — ingest skips already-downloaded files, face extraction clears its own partial output, and re-running the upload into an existing `[Organized]/` tree checks for existing shortcuts before creating new ones.

Full details of the v2 optimization pass (what changed and why, plus every tuning threshold): [`docs/CHANGELOG-v2.md`](docs/CHANGELOG-v2.md).

Every problem hit so far, its root cause and the rule that prevents it, grouped by area: [`docs/LESSONS.md`](docs/LESSONS.md). Read the section for the area you are about to touch.
