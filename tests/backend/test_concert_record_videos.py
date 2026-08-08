from __future__ import annotations

from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlparse

import pytest

from src.backend.repositories import db_json_repository
from src.backend.services import youtube_validation_service


pytestmark = pytest.mark.db_profile


class _FakeOEmbedResponse:
    status = 200

    def __init__(self, title: str, thumbnail_url: str):
        self._body = {
            "title": title,
            "thumbnail_url": thumbnail_url,
        }

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        import json

        return json.dumps(self._body, ensure_ascii=False).encode("utf-8")


def _seed_devices(seed_device_fn) -> None:
    seed_device_fn(
        device_id="dev-admin",
        permission="管理者",
        member_id="member-admin",
        member_name="Admin",
    )
    seed_device_fn(
        device_id="dev-system",
        permission="システム管理者",
        member_id="member-system",
        member_name="System",
    )
    seed_device_fn(
        device_id="dev-member",
        permission="一般",
        member_id="member-member",
        member_name="Member",
    )


def _create_performance(client, headers, title: str, date: str) -> int:
    response = client.post(
        "/api/performances",
        headers=headers,
        json={
            "title": title,
            "date": date,
            "open_time": "17:00",
            "start_time": "18:00",
            "venue": "Hall",
            "conductor": "Cond",
            "pieces": [],
        },
    )
    assert response.status_code == 200
    return int(response.json()["id"])


def _video_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _fake_urlopen_factory(mapping: dict[str, tuple[str, str] | str]):
    def fake_urlopen(request, timeout=5):
        request_url = request.full_url if hasattr(request, "full_url") else str(request)
        target = unquote(parse_qs(urlparse(request_url).query).get("url", [""])[0])
        lookup = youtube_validation_service.normalize_youtube_url(target)
        value = mapping.get(lookup.video_id)
        if value == "missing":
            raise HTTPError(request_url, 404, "Not Found", hdrs=None, fp=None)
        if value == "transient":
            raise URLError("temporary")
        title, thumbnail_url = value
        return _FakeOEmbedResponse(title, thumbnail_url)

    return fake_urlopen


def test_concert_record_video_permissions_and_youtube_validation(client, seed_device_fn, monkeypatch):
    _seed_devices(seed_device_fn)
    admin_headers = {"X-Device-Id": "dev-admin"}
    system_headers = {"X-Device-Id": "dev-system"}
    member_headers = {"X-Device-Id": "dev-member"}

    _create_performance(client, admin_headers, "Concert A", "2026-07-01")

    monkeypatch.setattr(
        youtube_validation_service,
        "urlopen",
        _fake_urlopen_factory({
            "abcdefghijk": ("【福岡奏オーケストラ】第1回記録", "https://img.example/abcdefghijk.jpg"),
            "lmnopqrstuv": ("【福岡奏オーケストラ】第2回記録", "https://img.example/lmnopqrstuv.jpg"),
        }),
    )

    created = client.post(
        "/api/extra/concert_record_videos",
        headers=admin_headers,
        json={"performance_id": 1, "youtube_url": _video_url("abcdefghijk")},
    )
    assert created.status_code == 200
    body = created.json()
    assert body["youtube_url"] == _video_url("abcdefghijk")
    assert body["title"] == "第1回記録"
    assert body["thumbnail_url"] == "https://img.example/abcdefghijk.jpg"
    assert body["sort_order"] == 1

    invalid = client.post(
        "/api/extra/concert_record_videos",
        headers=admin_headers,
        json={"performance_id": 1, "youtube_url": "https://example.com/watch?v=abcdefghijk"},
    )
    assert invalid.status_code == 400

    monkeypatch.setattr(
        youtube_validation_service,
        "urlopen",
        _fake_urlopen_factory({"abcdefghijk": "missing"}),
    )
    missing = client.post(
        "/api/extra/concert_record_videos",
        headers=admin_headers,
        json={"performance_id": 1, "youtube_url": _video_url("abcdefghijk")},
    )
    assert missing.status_code == 400

    monkeypatch.setattr(
        youtube_validation_service,
        "urlopen",
        _fake_urlopen_factory({"abcdefghijk": "transient"}),
    )
    transient = client.post(
        "/api/extra/concert_record_videos",
        headers=admin_headers,
        json={"performance_id": 1, "youtube_url": _video_url("abcdefghijk")},
    )
    assert transient.status_code == 503

    monkeypatch.setattr(
        youtube_validation_service,
        "urlopen",
        _fake_urlopen_factory({
            "abcdefghijk": ("【福岡奏オーケストラ】第1回記録", "https://img.example/abcdefghijk.jpg"),
            "lmnopqrstuv": ("【福岡奏オーケストラ】第2回記録", "https://img.example/lmnopqrstuv.jpg"),
        }),
    )
    created_by_system = client.post(
        "/api/extra/concert_record_videos",
        headers=system_headers,
        json={"performance_id": 1, "youtube_url": _video_url("lmnopqrstuv")},
    )
    assert created_by_system.status_code == 200

    denied_create = client.post(
        "/api/extra/concert_record_videos",
        headers=member_headers,
        json={"performance_id": 1, "youtube_url": _video_url("abcdefghijk")},
    )
    assert denied_create.status_code == 403

    denied_update = client.put(
        f"/api/extra/concert_record_videos/{body['id']}",
        headers=member_headers,
        json={"payload": {**body, "youtube_url": _video_url("lmnopqrstuv")}, "expected_updated_at": body["updated_at"]},
    )
    assert denied_update.status_code == 403

    denied_delete = client.delete(
        f"/api/extra/concert_record_videos/{body['id']}",
        headers=member_headers,
    )
    assert denied_delete.status_code == 403


def test_concert_record_video_sorting_edit_move_and_delete(client, seed_device_fn, monkeypatch):
    _seed_devices(seed_device_fn)
    admin_headers = {"X-Device-Id": "dev-admin"}

    performance_a = _create_performance(client, admin_headers, "Concert A", "2026-07-01")
    performance_b = _create_performance(client, admin_headers, "Concert B", "2026-08-01")

    monkeypatch.setattr(
        youtube_validation_service,
        "urlopen",
        _fake_urlopen_factory({
            "aaaaaaaaaaa": ("【福岡奏オーケストラ】A1", "https://img.example/a1.jpg"),
            "bbbbbbbbbbb": ("【福岡奏オーケストラ】A2", "https://img.example/a2.jpg"),
            "ccccccccccc": ("【福岡奏オーケストラ】A3", "https://img.example/a3.jpg"),
            "ddddddddddd": ("【福岡奏オーケストラ】B1", "https://img.example/b1.jpg"),
            "eeeeeeeeeee": ("【福岡奏オーケストラ】A2 updated", "https://img.example/a2b.jpg"),
            "fffffffffff": ("【福岡奏オーケストラ】A2 moved", "https://img.example/a2c.jpg"),
        }),
    )

    first = client.post("/api/extra/concert_record_videos", headers=admin_headers, json={"performance_id": performance_a, "youtube_url": _video_url("aaaaaaaaaaa")})
    second = client.post("/api/extra/concert_record_videos", headers=admin_headers, json={"performance_id": performance_a, "youtube_url": _video_url("bbbbbbbbbbb")})
    third = client.post("/api/extra/concert_record_videos", headers=admin_headers, json={"performance_id": performance_a, "youtube_url": _video_url("ccccccccccc")})
    other = client.post("/api/extra/concert_record_videos", headers=admin_headers, json={"performance_id": performance_b, "youtube_url": _video_url("ddddddddddd")})
    assert first.status_code == second.status_code == third.status_code == other.status_code == 200

    listed = client.get("/api/extra/concert_record_videos")
    assert [item["sort_order"] for item in listed.json() if item["performance_id"] == performance_a] == [1, 2, 3]

    second_body = second.json()
    moved_up = client.put(
        f"/api/extra/concert_record_videos/{second_body['id']}",
        headers=admin_headers,
        json={
            "payload": {
                **second_body,
                "sort_order": 1,
            },
            "expected_updated_at": second_body["updated_at"],
        },
    )
    assert moved_up.status_code == 200
    assert [item["title"] for item in client.get("/api/extra/concert_record_videos").json() if item["performance_id"] == performance_a] == ["A2", "A1", "A3"]

    moved_up_body = moved_up.json()
    updated_same_perf = client.put(
        f"/api/extra/concert_record_videos/{moved_up_body['id']}",
        headers=admin_headers,
        json={
            "payload": {
                **moved_up_body,
                "youtube_url": _video_url("eeeeeeeeeee"),
                "sort_order": moved_up_body["sort_order"],
            },
            "expected_updated_at": moved_up_body["updated_at"],
        },
    )
    assert updated_same_perf.status_code == 200
    updated_same_perf_body = updated_same_perf.json()
    assert updated_same_perf_body["title"] == "A2 updated"
    assert updated_same_perf_body["thumbnail_url"] == "https://img.example/a2b.jpg"
    assert updated_same_perf_body["sort_order"] == 1

    moved_to_other_perf = client.put(
        f"/api/extra/concert_record_videos/{updated_same_perf_body['id']}",
        headers=admin_headers,
        json={
            "payload": {
                **updated_same_perf_body,
                "performance_id": performance_b,
                "youtube_url": _video_url("fffffffffff"),
            },
            "expected_updated_at": updated_same_perf_body["updated_at"],
        },
    )
    assert moved_to_other_perf.status_code == 200
    moved_to_other_perf_body = moved_to_other_perf.json()
    assert moved_to_other_perf_body["performance_id"] == performance_b
    assert moved_to_other_perf_body["sort_order"] == 2

    after_move = client.get("/api/extra/concert_record_videos").json()
    perf_a_orders = [item["sort_order"] for item in after_move if item["performance_id"] == performance_a]
    perf_b_orders = [item["sort_order"] for item in after_move if item["performance_id"] == performance_b]
    assert perf_a_orders == [1, 2]
    assert perf_b_orders == [1, 2]

    deleted = client.delete(
        f"/api/extra/concert_record_videos/{moved_to_other_perf_body['id']}",
        headers=admin_headers,
    )
    assert deleted.status_code == 200
    after_delete = client.get("/api/extra/concert_record_videos").json()
    assert [item["sort_order"] for item in after_delete if item["performance_id"] == performance_b] == [1]


def test_concert_record_video_db_replace_collection_handles_sort_order_swaps(monkeypatch):
    class _FakeCursor:
        def __init__(self, database):
            self._database = database
            self.connection = database.connection
            self._rows = []
            self.description = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def _ensure_unique(self):
            seen: set[tuple[str, int, int]] = set()
            for row in self._database.rows:
                key = (str(row.get("organization_id") or ""), int(row.get("performance_id") or 0), int(row.get("sort_order") or 0))
                if key in seen:
                    raise AssertionError(f"duplicate concert_record_videos key detected: {key}")
                seen.add(key)

        def execute(self, query, params=None):
            sql = str(query)
            if "information_schema.columns" in sql:
                self._rows = [(1,)]
                self.description = [("1",)]
                return
            if "SELECT COALESCE(MAX(id), 0) FROM" in sql:
                max_id = max((int(row.get("id") or 0) for row in self._database.rows), default=0)
                self._rows = [(max_id,)]
                self.description = [("coalesce",)]
                return
            if "SELECT id, performance_id, sort_order FROM" in sql:
                tenant_id = str((params or ("",))[0] or "")
                ordered_rows = [
                    row
                    for row in self._database.rows
                    if str(row.get("organization_id") or "") == tenant_id
                ]
                ordered_rows.sort(key=lambda row: (int(row.get("performance_id") or 0), int(row.get("sort_order") or 0), int(row.get("id") or 0)))
                self._rows = [
                    (int(row.get("id") or 0), int(row.get("performance_id") or 0), int(row.get("sort_order") or 0))
                    for row in ordered_rows
                ]
                self.description = [("id",), ("performance_id",), ("sort_order",)]
                return
            if "DELETE FROM" in sql and "NOT (id = ANY(%s))" in sql:
                tenant_id, kept_ids = params
                kept_set = {int(value) for value in kept_ids}
                self._database.rows = [
                    row
                    for row in self._database.rows
                    if str(row.get("organization_id") or "") != str(tenant_id or "") or int(row.get("id") or 0) in kept_set
                ]
                self._ensure_unique()
                return
            if "DELETE FROM" in sql:
                tenant_id = str((params or ("",))[0] or "") if params else ""
                self._database.rows = [row for row in self._database.rows if str(row.get("organization_id") or "") != tenant_id]
                self._ensure_unique()
                return
            if "UPDATE" in sql and "SET sort_order = %s WHERE id = %s" in sql:
                new_sort_order, row_id = params
                for row in self._database.rows:
                    if int(row.get("id") or 0) == int(row_id):
                        row["sort_order"] = int(new_sort_order)
                        break
                self._ensure_unique()
                return
            if "INSERT INTO" in sql:
                columns = list(db_json_repository.DB_COLLECTION_COLUMNS["concert_record_videos"])
                row = dict(zip(columns, params))
                row["id"] = int(row.get("id") or 0)
                row["performance_id"] = int(row.get("performance_id") or 0)
                row["sort_order"] = int(row.get("sort_order") or 0)
                row["organization_id"] = str(row.get("organization_id") or "")
                existing = next(
                    (
                        item
                        for item in self._database.rows
                        if int(item.get("id") or 0) == row["id"]
                    ),
                    None,
                )
                if existing is None:
                    self._database.rows.append(row)
                else:
                    existing.update(row)
                self._ensure_unique()
                return
            raise AssertionError(f"Unexpected SQL: {sql}")

        def executemany(self, query, seq):
            for params in seq:
                self.execute(query, params)

        def fetchone(self):
            return self._rows[0] if self._rows else None

        def fetchall(self):
            return list(self._rows)

    class _FakeConnection:
        def __init__(self, database):
            self._database = database
            self.connection = self

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def cursor(self):
            return _FakeCursor(self._database)

        def commit(self):
            return None

    class _FakeDatabase:
        def __init__(self, rows):
            self.rows = [dict(row) for row in rows]
            self.connection = _FakeConnection(self)

    database = _FakeDatabase(
        [
            {"id": 10, "organization_id": "default", "performance_id": 1, "youtube_url": _video_url("aaaaaaaaaaa"), "title": "A1", "thumbnail_url": "https://img.example/a1.jpg", "sort_order": 1},
            {"id": 20, "organization_id": "default", "performance_id": 1, "youtube_url": _video_url("bbbbbbbbbbb"), "title": "A2", "thumbnail_url": "https://img.example/a2.jpg", "sort_order": 2},
            {"id": 30, "organization_id": "default", "performance_id": 2, "youtube_url": _video_url("ccccccccccc"), "title": "B1", "thumbnail_url": "https://img.example/b1.jpg", "sort_order": 1},
        ]
    )

    monkeypatch.setattr(db_json_repository, "get_current_tenant_id", lambda: "default")
    monkeypatch.setattr(db_json_repository, "table_has_organization_id", lambda conn, table_name: table_name == "concert_record_videos")
    monkeypatch.setattr(db_json_repository, "db_connection_string", lambda: "postgresql://example")
    monkeypatch.setattr(db_json_repository.psycopg, "connect", lambda *args, **kwargs: database.connection)

    final_rows = [
        {"id": 10, "organization_id": "default", "performance_id": 1, "youtube_url": _video_url("aaaaaaaaaaa"), "title": "A1", "thumbnail_url": "https://img.example/a1.jpg", "sort_order": 2},
        {"id": 20, "organization_id": "default", "performance_id": 1, "youtube_url": _video_url("bbbbbbbbbbb"), "title": "A2", "thumbnail_url": "https://img.example/a2.jpg", "sort_order": 1},
        {"id": 30, "organization_id": "default", "performance_id": 2, "youtube_url": _video_url("ccccccccccc"), "title": "B1", "thumbnail_url": "https://img.example/b1.jpg", "sort_order": 1},
    ]

    db_json_repository.replace_collection("concert_record_videos", final_rows)

    assert [
        (int(row["id"]), int(row["performance_id"]), int(row["sort_order"]))
        for row in sorted(database.rows, key=lambda row: (int(row["performance_id"]), int(row["sort_order"]), int(row["id"])))
    ] == [
        (20, 1, 1),
        (10, 1, 2),
        (30, 2, 1),
    ]
