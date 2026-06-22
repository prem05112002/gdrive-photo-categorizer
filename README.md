# Google Drive Photo Categorizer

A local web app that takes a Google Drive folder full of trip photos, runs face recognition and scene classification, lets you name each person in the photos, and writes back an organized `[Organized]/` folder structure directly into your Drive — with subfolders per person, per scene, and for RAW files — all using Drive shortcuts (no re-uploading, no copies).

---

## How it works — end to end

```
Google Drive folder
        │
        ▼
  1. INGEST          Download all photos. Detect duplicates via pHash.
                     Flag RAW files and videos separately.
        │
        ▼
  2. FACE PIPELINE   Run InsightFace buffalo_l on every standard image.
                     Extract 512-dim face embeddings + face crop thumbnails.
                     Flag group photos (≥ 5 faces).
        │
        ▼
  3. ENROLLMENT      DBSCAN clusters the embeddings by similarity.
                     You review clusters in the UI and name each person
                     (or dismiss strangers). Embeddings are saved to the registry.
        │
        ▼
  4. CLASSIFY        FAISS matches remaining unassigned faces against the registry.
                     Photos with no faces get a scene label via OpenCLIP (ViT-B-32).
        │
        ▼
  5. BODY DETECT     YOLOv8x-seg detects full-body person silhouettes.
                     HSV outfit histograms link bodies (without visible faces)
                     to enrolled persons using colour correlation.
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

### 2. DBSCAN (scikit-learn)
**Task:** Unsupervised face clustering  
**Where used:** Enrollment step (step 3)

Clusters the raw 512-dim embeddings using cosine distance (via scikit-learn's `metric="cosine"`).

| Parameter | Value | Meaning |
|---|---|---|
| `eps` | 0.35 | Max cosine distance within a cluster (≈ similarity ≥ 0.65) |
| `min_samples` | 1 | Every face starts as its own cluster — no faces are discarded |

Clusters are sorted by size (most-seen person first) and presented to the user for naming. Singletons (< 3 faces) are flagged as likely strangers.

---

### 3. FAISS — `IndexFlatIP`
**Task:** Fast nearest-neighbour face matching against the enrolled registry  
**Where used:** Classify step (step 4)

After you name people in enrollment, FAISS builds an exact inner-product index over all saved `PersonEmbedding` vectors. For every unassigned face in the trip it does a k=1 search and assigns the best match if cosine similarity ≥ 0.5.

Because FAISS and PyTorch both bundle `libomp.dylib`, loading both in the same process causes a SIGSEGV on macOS ARM64. The scene classifier is therefore run in a **separate subprocess** (`scene_classify_worker.py`).

---

### 4. OpenCLIP — `ViT-B-32` (OpenAI pretrained)
**Task:** Zero-shot scene classification for photos with no detected faces  
**Where used:** Classify step (step 4), runs in a subprocess worker  
**Downloaded automatically** on first run (~340 MB, cached by `open_clip`)

Encodes both the image and a list of text prompts (`"a photo of beach"`, etc.) using the CLIP vision transformer, then picks the label whose text embedding has the highest cosine similarity with the image embedding.

Scene labels used:

| Label | Label | Label | Label | Label |
|---|---|---|---|---|
| beach | mountain | temple | monument | street |
| market | nature | indoor | food | other |

---

### 5. YOLOv8x-seg (Ultralytics)
**Task:** Full-body person detection with instance segmentation masks  
**Where used:** Body detection step (step 5), runs in a subprocess worker  
**Model file:** `backend/yolov8x-seg.pt` — downloaded automatically on first run by `ultralytics` (~137 MB)

Runs on every photo in the trip with `conf=0.3`, class 0 (person only). For each detected body it produces:
- A bounding box
- A per-pixel segmentation mask (used to compute the outfit colour histogram)

Forced to `device="cpu"` — MPS triggers a segfault on Python 3.14 / macOS ARM64.

---

### 6. HSV Colour Histogram (OpenCV)
**Task:** Outfit fingerprinting and body-to-person matching  
**Where used:** Body detection step (step 5)

For each detected body, a 32×32×32 HSV histogram is computed over the segmentation mask pixels only (clothing, not background). This histogram is the "outfit signature" for that person on that day.

Two uses:
1. **Face-linked bodies:** If a face observation inside the bounding box is already assigned to a person, the histogram is averaged into that person's `PersonOutfit` record for the trip date.
2. **Unmatched bodies:** Bodies with no face match are compared against all enrolled outfit histograms using cosine similarity. If a match exceeds 0.65, the body is suggested as that person (surfaces in the Review tab for confirmation).

---

## Project structure

```
.
├── backend/
│   ├── api/                  FastAPI route handlers
│   ├── database/             SQLAlchemy models, CRUD helpers, schema
│   ├── drive/                Google Drive auth + download + shortcut upload
│   ├── enrollment/           DBSCAN clustering + enrollment router
│   ├── pipeline/             Face, scene, and body detection pipelines
│   │   ├── face.py           InsightFace runner (in-process)
│   │   ├── classify.py       FAISS matcher + subprocess launcher
│   │   ├── scene_classify_worker.py   OpenCLIP subprocess (isolated)
│   │   ├── body.py           YOLOv8 subprocess launcher
│   │   └── body_detect_worker.py      YOLOv8 + HSV histogram subprocess (isolated)
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
**Linux:** Should work. The subprocess isolation for FAISS/PyTorch is more relevant on macOS ARM64 but harmless elsewhere.  
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

This installs all Python dependencies including PyTorch, InsightFace, FAISS, OpenCLIP, Ultralytics, and the Google Drive client library.

> **First run note:** On the very first pipeline run, the following models are downloaded automatically:
> - `buffalo_l` (InsightFace) — ~235 MB → `~/.insightface/models/buffalo_l/`
> - `ViT-B-32` (OpenCLIP) — ~340 MB → `~/.cache/huggingface/`
> - `yolov8x-seg.pt` (Ultralytics) — ~137 MB → `backend/yolov8x-seg.pt`

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

2. **Ingest** — the app downloads all photos, detects duplicates (perceptual hash), and catalogues RAW files and videos.

3. **Run face pipeline** — InsightFace scans every standard image. This is the slowest step: expect ~2–5 seconds per photo on an M2 Pro with CoreML, longer on CPU.

4. **Enroll people** — clusters of similar faces are shown. Type a name for each cluster. Click "Dismiss" for strangers or background faces you don't want to track. Once all expected members are named, proceed.

5. **Classify** — FAISS matches remaining faces to your enrolled registry. OpenCLIP labels all no-face photos by scene.

6. **Body detection** (optional but recommended) — YOLOv8 finds people in every photo using full-body detection. Useful for photos where faces are obscured or too small to detect.

7. **Review** — check the Persons tab (face counts per person), the Gallery tab (browse by scene), and the Misc tab (faces that couldn't be auto-matched). Reassign or dismiss any errors.

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
| `backend/yolov8x-seg.pt` | YOLOv8x-seg model weights | No — re-downloaded on next body detection run |
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
→ Ensure `yolov8x-seg.pt` is in `backend/` (it auto-downloads on first run; if the download was interrupted, delete the partial file and try again).

**Face pipeline is very slow**  
→ On non-Apple-Silicon systems, InsightFace runs on CPU only. A 500-photo trip can take 30–60 minutes. On M-series Macs with CoreML, the same trip takes 5–15 minutes.

**`SIGSEGV` or segfault during classification or body detection**  
→ This is a known macOS ARM64 conflict between FAISS and PyTorch sharing `libomp`. The app routes scene classification and body detection through subprocess workers to avoid it. If you see a segfault in the main process, open an issue with your Python version and OS.

---

## Architecture notes

- **No cloud dependency beyond Google Drive** — all models run locally, all data stays on your machine.
- **Person registry is global** — persons you enroll in one trip are available to auto-match in future trips via FAISS. The same person traveling in two separate trips only needs to be named once.
- **Subprocess isolation** — FAISS (used for face matching) and PyTorch (used for OpenCLIP and YOLOv8) cannot safely coexist in the same process on macOS ARM64. The app spawns `scene_classify_worker.py` and `body_detect_worker.py` as isolated child processes that communicate via JSON on stdout.
- **Shortcuts, not copies** — the Drive upload step creates `application/vnd.google-apps.shortcut` files, so every photo appears in person and scene folders without consuming additional Drive storage.
- **Idempotent upload** — re-running the upload on an already-uploaded trip checks for existing shortcuts before creating new ones, so it is safe to re-run if it was interrupted.
