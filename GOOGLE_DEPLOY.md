# Google Drive / Google Sites publish steps

This app can store uploaded or converted recordings in Google Drive and show share links in the member recording page.

## 1. Enable Google Drive API

1. Create or select a Google Cloud project.
2. Enable Google Drive API.
3. Create a service account for Cloud Run.
4. Create a Drive folder for recordings.
5. Share that Drive folder with the service account email as Editor.
6. Copy the folder ID from the folder URL after `/folders/`.

## 2. Choose Drive sharing scope

Anyone with the link:

```env
GOOGLE_DRIVE_PERMISSION_TYPE=anyone
GOOGLE_DRIVE_PERMISSION_ROLE=reader
```

Only your Google Workspace domain:

```env
GOOGLE_DRIVE_PERMISSION_TYPE=domain
GOOGLE_DRIVE_PERMISSION_ROLE=reader
GOOGLE_DRIVE_PERMISSION_DOMAIN=example.org
```

## 3. Deploy to Cloud Run

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com drive.googleapis.com
gcloud run deploy orchestra-tool `
  --source . `
  --region asia-northeast1 `
  --allow-unauthenticated `
  --set-env-vars GOOGLE_DRIVE_FOLDER_ID=YOUR_FOLDER_ID,GOOGLE_DRIVE_PERMISSION_TYPE=anyone,GOOGLE_DRIVE_PERMISSION_ROLE=reader
```

Copy the deployed `https://...run.app` URL.

## 4. Add to Google Sites

1. Open the member Google Site.
2. Use Insert > Embed.
3. Paste the Cloud Run URL.
4. Publish the page.

Set the Google Sites visibility to match your orchestra policy.

## 5. Verify

1. Open the app as an administrator.
2. Upload a WAV or MP3 file.
3. Click `MP3に変換`.
4. The converted MP3 is uploaded to Drive when `GOOGLE_DRIVE_FOLDER_ID` is configured.
5. Members can open the recording from `団員メニュー > 録音部屋`.

## Notes

- WAV to MP3 conversion requires ffmpeg. The Dockerfile installs it.
- `--allow-unauthenticated` makes the app reachable from the internet. For stricter access, combine Google Sites visibility, Cloud Run authentication, or IAP.
- For local service account JSON credentials, place the file under `credentials/`. That directory is ignored by git.
