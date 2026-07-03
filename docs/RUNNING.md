# Running the App

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.11+ | `python3 --version` |
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |
| macOS | Any (M2 Pro recommended) | Windows/Linux untested |

---

## One-time Setup

### 1. Google Cloud — Drive API credentials

This is required before the app can read any Drive folder.

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. "photo-categorizer")
3. **APIs & Services → Enable APIs → search "Google Drive API" → Enable**
4. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Desktop app**
   - Name: anything (e.g. "photo-categorizer-local")
5. Click **Download JSON** → rename the file to `credentials.json`
6. Move it into the `backend/` directory:
   ```
   backend/credentials.json   ← must be here
   ```
7. **APIs & Services → OAuth consent screen**
   - User type: External
   - Add your own Google account as a **test user**

The first time you run the app, a browser tab will open for Google consent. After you approve, a `token.json` is saved in `backend/` and reused on every subsequent run.

### 2. Python virtual environment

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Frontend dependencies

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

This starts both servers and prints their URLs. Press `Ctrl+C` to stop both.

### Option B — Manually in two terminals

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

### Ports

| Server | URL |
|---|---|
| Frontend (React) | http://localhost:5173 |
| Backend (FastAPI) | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |

---

## What each server does

- **Frontend** — the UI. All user interaction happens here.
- **Backend** — handles Drive API calls, runs face/scene pipelines, manages the local SQLite registry (`backend/registry.db`).
- The frontend proxies all `/api/*` requests to the backend, so you only need to open `localhost:5173`.

---

## Files created at runtime

| File / Folder | What it is | Safe to delete? |
|---|---|---|
| `backend/registry.db` | SQLite database — all persons, trips, photos | Deleting resets the entire registry |
| `backend/token.json` | Cached Google OAuth token | Yes — re-auth on next run |
| `backend/temp/{trip_id}/` | Downloaded photos for a trip | Yes after a trip is fully uploaded to Drive |
| `backend/temp/{trip_id}/raw/` | RAW files from DSLRs | Yes after confirmed not needed |
| `backend/temp/{trip_id}/videos/` | Video files (MP4, MOV, etc.) | Yes after confirmed not needed |

---

## Troubleshooting

**`credentials.json not found`**
→ Follow the Google Cloud setup above. The file must be at `backend/credentials.json`.

**`ModuleNotFoundError`**
→ You're not in the venv. Run `source backend/.venv/bin/activate` first.

**Frontend shows blank page / can't reach API**
→ Make sure the backend is running on port 8000. Check `localhost:8000/api/health` — should return `{"status":"ok"}`.

**Drive listing returns 0 files**
→ Make sure the folder is shared with your Google account, or that you're authenticated with the account that owns the folder.

**HEIC files fail to open**
→ `pillow-heif` requires libheif. On macOS: `brew install libheif` then `pip install --force-reinstall pillow-heif`.

---

## Current build status

> Last updated: 2026-07-03 — v2 optimization pass complete (see [`CHANGELOG-v2.md`](CHANGELOG-v2.md))

| Phase | Status | What it covers |
|---|---|---|
| **Phase 0 — Foundation** | ✅ Done + tested | Drive ingestion (12-way parallel, md5 pre-dedupe, resumable), RAW/video handling, basic UI |
| **Phase 1 — Face Pipeline** | ✅ Done + tested | InsightFace buffalo_l, CoreML EP, 512-dim embeddings, face crops, quality gate |
| **Phase 2 — Enrollment** | ✅ Done + tested | Two-stage clustering (agglomerative + singleton attachment), suggestion chips, roster UI |
| **Phase 3 — Classification** | ✅ Done + tested | numpy registry matching with margin rule, SigLIP 2 scene labels, parallel Drive shortcut upload |
| **Phase 4 — Review** | ✅ Done + tested | `/review` page: persons + scenes + Misc viewer with assign/create |
| **Phase 5 — Polish** | ✅ Done | Error persistence, retry from failures, delete trip, idempotent re-upload, status labels |
| **v2 — Optimization** | ✅ Done, ⏳ pending end-to-end verification | All of the above rewritten for speed/accuracy; DB wiped; blocked on Google OAuth re-consent |

The app is fully functional end-to-end. The v2 rewrite still needs one full real-trip run to validate the new tuning thresholds.
