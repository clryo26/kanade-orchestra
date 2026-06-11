import json
import os
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


SCOPES = ["https://www.googleapis.com/auth/drive"]


def get_drive_service():
    service_account_json = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]
    info = json.loads(service_account_json)

    credentials = service_account.Credentials.from_service_account_info(
        info,
        scopes=SCOPES,
    )

    return build("drive", "v3", credentials=credentials)


def create_folder(service, name, parent_id):
    query = (
        f"name='{name}' and "
        f"mimeType='application/vnd.google-apps.folder' and "
        f"'{parent_id}' in parents and trashed=false"
    )

    result = service.files().list(
        q=query,
        fields="files(id, name)",
        supportsAllDrives=True,
    ).execute()

    files = result.get("files", [])
    if files:
        return files[0]["id"]

    metadata = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }

    folder = service.files().create(
        body=metadata,
        fields="id",
        supportsAllDrives=True,
    ).execute()

    return folder["id"]


def upload_file_to_drive(local_path, practice_date, song_name):
    service = get_drive_service()

    root_folder_id = os.environ["GOOGLE_DRIVE_FOLDER_ID"]

    date_folder_id = create_folder(service, practice_date, root_folder_id)
    song_folder_id = create_folder(service, song_name, date_folder_id)

    file_path = Path(local_path)

    metadata = {
        "name": file_path.name,
        "parents": [song_folder_id],
    }

    media = MediaFileUpload(
        str(file_path),
        mimetype="audio/mpeg",
        resumable=True,
    )

    uploaded = service.files().create(
        body=metadata,
        media_body=media,
        fields="id, name, webViewLink, webContentLink",
        supportsAllDrives=True,
    ).execute()

    permission_type = os.environ.get("GOOGLE_DRIVE_PERMISSION_TYPE", "anyone")
    permission_role = os.environ.get("GOOGLE_DRIVE_PERMISSION_ROLE", "reader")

    service.permissions().create(
        fileId=uploaded["id"],
        body={
            "type": permission_type,
            "role": permission_role,
        },
        supportsAllDrives=True,
    ).execute()

    return {
        "id": uploaded["id"],
        "name": uploaded["name"],
        "view_url": uploaded.get("webViewLink"),
        "download_url": uploaded.get("webContentLink"),
    }
