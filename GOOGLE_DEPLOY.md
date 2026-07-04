# Google Cloud Storage / Google Sites publish steps

This app can store uploaded or converted recordings in Google Cloud Storage and show links in the member recording page.

## 1. Prepare Google Cloud Storage

1. Create or select a Google Cloud project.
2. Enable Cloud Run, Cloud Build, and Cloud Storage APIs.
3. Create a Cloud Storage bucket for recordings.
4. Create a service account for Cloud Run.
5. Grant the service account `Storage Object Admin` on the bucket.

## 2. Choose object visibility

Private bucket, recommended:

```env
GOOGLE_CLOUD_STORAGE_PUBLIC=false
```

Public object URLs:

```env
GOOGLE_CLOUD_STORAGE_PUBLIC=true
```

When public URLs are disabled, the app still records the object URL, but users need bucket/object permissions to open it.

## 3. Deploy to Cloud Run

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com storage.googleapis.com
gcloud run deploy orchestra-tool `
  --source . `
  --region asia-northeast2 `
  --allow-unauthenticated `
  --set-env-vars GOOGLE_CLOUD_STORAGE_BUCKET=YOUR_BUCKET_NAME,GOOGLE_CLOUD_STORAGE_PUBLIC=false
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
3. Click the MP3 conversion button.
4. The converted MP3 is uploaded to Cloud Storage when `GOOGLE_CLOUD_STORAGE_BUCKET` is configured.
5. Members can open the recording from the member recording page.

## Notes

- WAV to MP3 conversion requires ffmpeg. The Dockerfile installs it.
- `--allow-unauthenticated` makes the app reachable from the internet. For stricter access, combine Google Sites visibility, Cloud Run authentication, or IAP.
- For local service account JSON credentials, place the file under `credentials/`. That directory is ignored by git.
