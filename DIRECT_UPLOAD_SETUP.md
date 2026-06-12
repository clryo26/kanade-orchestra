# GCS直接アップロード設定

大きなWAVをCloud Run経由で送ると32MiB制限に当たるため、ブラウザからGCSへ直接アップロードする方式に変更しています。

## 必須: GCSバケットのCORS設定

Cloud Shell または gcloud CLI で以下を実行してください。

```bash
gcloud storage buckets update gs://kanade-storage --cors-file=gcs-cors.json
```

反映後、Cloud Runを再デプロイしてください。
