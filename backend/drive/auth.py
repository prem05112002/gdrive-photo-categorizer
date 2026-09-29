from pathlib import Path
from google.auth.exceptions import RefreshError
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
    First run (or a dead cached token) opens a browser window for OAuth consent
    on this machine; afterwards the cached token.json is refreshed silently.
    """
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if creds and not creds.valid and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            TOKEN_FILE.write_text(creds.to_json())
        except RefreshError as e:
            # Consent screens left in "Testing" mode hand out refresh tokens that
            # die after 7 days (invalid_grant). Drop the dead token and re-consent
            # below instead of failing every Drive call until someone deletes
            # token.json by hand.
            print(f"[drive] cached token rejected ({e}); re-running consent")
            TOKEN_FILE.unlink(missing_ok=True)
            creds = None

    if not creds or not creds.valid:
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
        creds = flow.run_local_server(port=0)   # blocks until the browser flow completes
        TOKEN_FILE.write_text(creds.to_json())

    return build("drive", "v3", credentials=creds)


def revoke_token() -> None:
    """Remove cached token — forces re-auth on next run."""
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()
