from pathlib import Path
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/drive"]

_BASE = Path(__file__).parent.parent
CREDENTIALS_FILE = _BASE / "credentials.json"
TOKEN_FILE = _BASE / "token.json"


def get_drive_service():
    """
    Return an authenticated Drive v3 service object.
    On first run, opens a browser window for OAuth consent.
    Subsequent runs use the cached token.json.
    """
    creds = None

    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not CREDENTIALS_FILE.exists():
                raise FileNotFoundError(
                    "credentials.json not found in backend/.\n"
                    "Steps to fix:\n"
                    "  1. Go to console.cloud.google.com\n"
                    "  2. APIs & Services → Credentials → Create OAuth 2.0 Client ID\n"
                    "  3. Application type: Desktop app\n"
                    "  4. Download JSON and save as backend/credentials.json\n"
                    "  5. Enable the Google Drive API in the same project."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)

        TOKEN_FILE.write_text(creds.to_json())

    return build("drive", "v3", credentials=creds)


def revoke_token() -> None:
    """Remove cached token — forces re-auth on next run."""
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()
