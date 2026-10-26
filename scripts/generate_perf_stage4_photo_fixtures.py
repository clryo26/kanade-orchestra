"""Generate synthetic test photos only; no camera files, DB or GCS are used.

Commit the JPEGs and their manifest so subsequent comparisons use identical
input bytes even when an image encoder on another machine differs.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, __version__ as pillow_version, features


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests/fixtures/perf_stage4_photos"
MANIFEST = FIXTURE_DIR / "manifest.json"
SPECS = (
    ("landscape", 1600, 1200, 0x183A21, 1),
    ("portrait", 1200, 1800, 0x39B472, 1),
    ("high_resolution", 4096, 3072, 0x71CF35, 1),
    ("exif_rotated", 1800, 1200, 0x29D8A3, 6),
)


def encoded_photo(width, height, seed, orientation):
    # Integer xorshift32 plus coloured bands gives reproducible, multiscale
    # texture. Upscaling preserves detail visible in a 384px preview instead
    # of averaging independent high-resolution noise into a flat colour.
    data = bytearray(512 * 384 * 3)
    state = seed
    for y in range(384):
        for x in range(512):
            state ^= (state << 13) & 0xFFFFFFFF
            state ^= state >> 17
            state ^= (state << 5) & 0xFFFFFFFF
            state &= 0xFFFFFFFF
            bands = ((x // 19) ^ (y // 13)) * 23
            offset = (y * 512 + x) * 3
            data[offset] = (x // 2 + bands + (state & 255)) & 255
            data[offset + 1] = (y // 2 + bands + ((state >> 8) & 255)) & 255
            data[offset + 2] = ((x + y) // 3 + ((state >> 16) & 255)) & 255
    with Image.frombytes("RGB", (512, 384), bytes(data)) as texture:
        image = texture.resize((width, height), Image.Resampling.LANCZOS)
    try:
        # Four asymmetric corner markers make an EXIF rotation test check
        # actual orientation, not merely swapped width and height.
        draw = ImageDraw.Draw(image)
        dx, dy = width // 9, height // 9
        draw.rectangle((0, 0, dx, dy), fill=(240, 20, 20))
        draw.rectangle((width - dx, 0, width - 1, dy), fill=(20, 220, 20))
        draw.rectangle((0, height - dy, dx, height - 1), fill=(20, 20, 240))
        draw.rectangle((width - dx, height - dy, width - 1, height - 1), fill=(240, 220, 20))
        exif = Image.Exif()
        exif[274] = orientation
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=90, subsampling=2, exif=exif)
        return output.getvalue()
    finally:
        image.close()


def build():
    blobs = {}
    images = []
    for name, width, height, seed, orientation in SPECS:
        filename = f"{name}.jpg"
        content = encoded_photo(width, height, seed, orientation)
        blobs[filename] = content
        display = [height, width] if orientation == 6 else [width, height]
        images.append({
            "id": name, "file": filename, "encoded_size": [width, height],
            "exif_orientation": orientation, "display_size": display,
            "seed": seed, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
        })
    manifest = {
        "recipe": "stage4-texture-xorshift32-bands-corners-v1",
        "synthetic_only": True, "jpeg_quality": 90, "jpeg_subsampling": 2,
        "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "generated_with": {"pillow": pillow_version, "jpeg": features.version_codec("jpg")},
        "images": images,
    }
    return blobs, (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--write", action="store_true", help="Write only the four synthetic JPEGs and manifest.")
    modes.add_argument("--check", action="store_true", help="Regenerate in memory and compare; no writes.")
    args = parser.parse_args(argv)
    blobs, manifest = build()
    blobs["manifest.json"] = manifest
    if args.write:
        FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
        for filename, content in blobs.items():
            (FIXTURE_DIR / filename).write_bytes(content)
    else:
        for filename, content in blobs.items():
            path = FIXTURE_DIR / filename
            if not path.is_file() or path.read_bytes() != content:
                raise SystemExit(f"Synthetic fixture differs: {filename}; check generator/encoder environment")
    print(f"Synthetic photo fixtures: {len(blobs) - 1} images, {'written' if args.write else 'unchanged'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
