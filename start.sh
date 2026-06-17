#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Backend
cd "$ROOT/backend"
if [ ! -d ".venv" ]; then
  echo "→ Creating Python venv…"
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt
echo "→ Starting backend on http://localhost:8000"
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!

# Frontend
cd "$ROOT/frontend"
echo "→ Starting frontend on http://localhost:5173"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo ""
echo "  Press Ctrl+C to stop both servers."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
