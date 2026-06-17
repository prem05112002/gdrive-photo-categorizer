"""
Deletes the [Organized] output folder from Drive (moves to trash).
Run from the project root:
  cd backend && source .venv/bin/activate && cd .. && python scripts/clear_drive_output.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from drive.auth import get_drive_service

OUTPUT_FOLDER_ID = "1eMIhqeawBDFgLkGJ8Zt-GkC7ChoBF8bM"

def main():
    service = get_drive_service()

    try:
        meta = service.files().get(fileId=OUTPUT_FOLDER_ID, fields="id,name,trashed").execute()
    except Exception as e:
        print(f"Could not find folder: {e}")
        return

    if meta.get("trashed"):
        print(f"Folder '{meta['name']}' is already in trash.")
        return

    print(f"Found: '{meta['name']}' ({OUTPUT_FOLDER_ID})")
    confirm = input("Move this folder to Drive trash? [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        return

    service.files().update(fileId=OUTPUT_FOLDER_ID, body={"trashed": True}).execute()
    print("Done — folder moved to Drive trash.")
    print("To permanently delete: open drive.google.com → Trash → Empty trash.")

if __name__ == "__main__":
    main()
