"""Storage normalization for member portraits only; never used by other assets."""
from __future__ import annotations

import io
from threading import BoundedSemaphore

from fastapi import HTTPException
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from .portal_file_asset_service import FileInput

PROFILE = "member-photo-v1"
FILENAME = PROFILE + ".webp"
MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 60_000_000
MAX_OUTPUT_BYTES = 200 * 1024
_worker = BoundedSemaphore(1)


def normalize(file: FileInput) -> FileInput:
    """Bound native decoder memory; no originals are written to storage.

    Called in a worker thread, after the operation digest/replay check and
    outside DB transactions. The JPEG draft path shrinks before EXIF/ICC copies.
    """
    if len(file.content) > MAX_INPUT_BYTES:
        raise HTTPException(413, detail="写真は20MiB以下のファイルを選択してください")
    if not _worker.acquire(timeout=5):
        raise TimeoutError("Member photo converter is busy")
    try:
        # Register lazily: importing the portal does not load a native HEIF
        # decoder or alter the upload rules of other kinds of assets.
        from pillow_heif import register_heif_opener
        register_heif_opener()
        try:
            with Image.open(io.BytesIO(file.content)) as image:
                if image.format not in {"JPEG", "MPO", "PNG", "WEBP", "HEIF", "GIF", "BMP", "TIFF"}:
                    raise ValueError("Unsupported portrait format")
                if image.width * image.height > MAX_PIXELS:
                    raise HTTPException(413, detail="写真は6000万画素以下の画像を選択してください")
                image.thumbnail((800, 800), Image.Resampling.LANCZOS)
                small = ImageOps.exif_transpose(image)
                mode = "RGBA" if "A" in small.getbands() or "transparency" in small.info else "RGB"
                profile = small.info.get("icc_profile")
                if profile:
                    # Palette PNGs carry an RGB profile but cannot be passed
                    # directly to ImageCms; expand their palette first.
                    if small.mode == "P":
                        small = small.convert(mode)
                    small = ImageCms.profileToProfile(
                        small, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                        ImageCms.createProfile("sRGB"), outputMode=mode,
                    )
                else:
                    small = small.convert(mode)
                for edge, quality in ((800, 75), (800, 65), (640, 65), (480, 60)):
                    small.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                    output = io.BytesIO()
                    small.save(output, "WEBP", quality=quality, method=4,
                               exif=b"", icc_profile=b"", xmp=b"")
                    content = output.getvalue()
                    if len(content) <= MAX_OUTPUT_BYTES:
                        with Image.open(io.BytesIO(content)) as check:
                            check.load()
                            if max(check.size) > 800:
                                raise ValueError("Unexpected normalized size")
                        return FileInput(content, "image/webp", ".webp", FILENAME)
                raise ValueError("Portrait could not be compressed")
        except HTTPException:
            raise
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError,
                Image.DecompressionBombError, ImageCms.PyCMSError) as exc:
            raise HTTPException(422, detail="写真を変換できません。別の画像を選択してください") from exc
    finally:
        _worker.release()
