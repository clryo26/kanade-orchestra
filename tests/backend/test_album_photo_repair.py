from __future__ import annotations

import pytest

from scripts import repair_album_photo_metadata as repair


def test_copy_parser_preserves_japanese_and_copy_escapes_with_crlf():
    data = (
        "COPY public.album_photos (id, album_id, filename, object_name, path) FROM stdin;\r\n"
        "1\t2\t写真\\t集合.jpg\talbums/2/a.jpg\t\\N\r\n"
        "\\.\r\n"
    ).encode()
    assert repair.photo_rows(data) == [{
        "id": 1, "album_id": 2, "filename": "写真\t集合.jpg",
        "object_name": "albums/2/a.jpg", "path": None,
    }]


def test_copy_parser_refuses_missing_or_malformed_photo_rows():
    with pytest.raises(ValueError, match="COPY block missing"):
        repair.photo_rows(b"COPY public.albums (id) FROM stdin;\n1\n\\.\n")
    with pytest.raises(ValueError, match="Malformed"):
        repair.photo_rows(b"COPY public.album_photos (id, album_id) FROM stdin;\n1\n\\.\n")


def test_recovery_refuses_changed_backup_before_extracting_or_connecting(monkeypatch):
    monkeypatch.setattr(repair, "command", lambda *_args, **_kw: b"changed backup")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        repair.recovery_rows("pg_restore")
