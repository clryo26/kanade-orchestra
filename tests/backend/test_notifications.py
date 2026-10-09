from __future__ import annotations

import asyncio
import base64
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from src.backend.core.auth_dependencies import get_device_auth
from src.backend.core.tenant_context import set_current_tenant_id, reset_current_tenant_id
from src.backend.routers import notifications
from src.backend.services import notification_service as service
from src.backend.services.notification_types import DEFAULT_PREFERENCES, NOTIFICATION_TYPES


def subscription():
    def encoded(value):
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    return {
        "endpoint": "https://fcm.googleapis.com/fcm/send/test",
        "keys": {"p256dh": encoded(b"\x04" + b"a" * 64), "auth": encoded(b"b" * 16)},
    }


def test_change_detection_matches_persisted_columns_and_time_normalization():
    schedule = {"id": 1, "date": "2026-10-18", "start_time": "13:00:00", "performance_id": 3}
    assert not service.data_changed(schedule, {**schedule, "start_time": "13:00", "performance_id": "3"}, "schedules")
    assert service.data_changed(schedule, {**schedule, "start_time": "14:00"}, "schedules")
    piece = {"id": 2, "performance_id": 3, "piece": "Symphony", "description": "one"}
    assert not service.data_changed(piece, {**piece, "performance_id": "3", "unsupported_field": "ignored"}, "piece_infos")
    assert service.data_changed(piece, {**piece, "description": "two"}, "piece_infos")


class FakeRepository:
    def __init__(self):
        self.settings = {}
        self.events = {}
        self.deliveries = {}
        self.targets = []
        self.active = True
        self.permission = "一般"

    def current_owner(self, org, member_id, device_id):
        return {"permission": self.permission}

    def preferences(self, org, member):
        return self.settings.setdefault((org, member), dict(DEFAULT_PREFERENCES))

    def save_preferences(self, org, member, patch):
        self.preferences(org, member).update(patch)
        return deepcopy(self.settings[(org, member)])

    def subscribed(self, *args):
        return False

    def subscribe(self, *args):
        self.active = True
        return "subscription-id"

    def unsubscribe(self, *args):
        self.active = False

    def enqueue(self, event_id, org, kind, payload):
        self.events.setdefault(
            event_id,
            {
                "id": event_id,
                "kind": kind,
                "payload": payload,
                "organization_id": org,
                "created_at": datetime.now(timezone.utc),
            },
        )

    @contextmanager
    def dispatch_lock(self, org):
        yield True

    def pending(self, org):
        return [item for item in self.events.values() if item["organization_id"] == org]

    def recipients(self, org, event):
        return self.targets

    def claim(self, event_id, sub_id):
        key = (event_id, sub_id)
        if key in self.deliveries:
            return False
        self.deliveries[key] = "sending"
        return True

    def finish(self, event_id, sub_id, status, http_status=None):
        self.deliveries[(event_id, sub_id)] = status
        if status == "invalid":
            self.active = False

    def complete(self, event_id):
        pass


@pytest.fixture
def repo(monkeypatch):
    fake = FakeRepository()
    monkeypatch.setattr(service, "_repo", fake)
    monkeypatch.setattr(notifications, "_repo", fake)
    monkeypatch.setenv("WEB_PUSH_ENABLED", "true")
    for name in ("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"):
        monkeypatch.setenv(name, "test-only")
    return fake


def recipient(sub_id="a", permission="一般", enabled="true", until=""):
    value = subscription()
    return {
        "id": sub_id,
        "permission": permission,
        "enabled": enabled,
        "system_access_until": until,
        "endpoint": value["endpoint"],
        **value["keys"],
    }


def test_all_categories_persist_defaults_and_only_expose_admin_category_to_admin(repo):
    assert len(DEFAULT_PREFERENCES) == 8 and all(DEFAULT_PREFERENCES.values())
    device = {"device_id": "device", "member_id": 3, "permission": "一般"}
    app = FastAPI()
    app.include_router(notifications.router)
    app.dependency_overrides[get_device_auth] = lambda: device
    with TestClient(app) as client:
        result = client.get("/api/notifications/settings")
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
        assert len(result.json()["categories"]) == 7
        assert len(repo.settings[("default", 3)]) == 8
        assert (
            client.put(
                "/api/notifications/settings", json={"preferences": {"improvements": False}}
            ).status_code
            == 403
        )
        assert (
            client.put(
                "/api/notifications/settings", json={"preferences": {"schedules": False}}
            ).status_code
            == 200
        )
        assert client.get("/api/notifications/settings").json()["preferences"]["schedules"] is False
        device["permission"] = "システム管理者"
        repo.permission = "システム管理者"
        assert len(client.get("/api/notifications/settings").json()["categories"]) == 8
        assert (
            client.put(
                "/api/notifications/settings", json={"preferences": {"bogus": True}}
            ).status_code
            == 422
        )
        assert (
            client.put(
                "/api/notifications/settings", json={"preferences": {"notices": "true"}}
            ).status_code
            == 422
        )


def test_hidden_account_and_unpermitted_subscription_are_rejected(repo):
    device = {"device_id": "device", "member_id": 3, "permission": "一般"}
    app = FastAPI()
    app.include_router(notifications.router)
    app.dependency_overrides[get_device_auth] = lambda: device
    with TestClient(app) as client:
        assert (
            client.post(
                "/api/notifications/subscriptions", json={**subscription(), "permission": "default"}
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/notifications/subscriptions", json={**subscription(), "permission": "granted"}
            ).status_code
            == 200
        )
        assert client.delete("/api/notifications/subscriptions").json() == {"ok": True}
        assert not repo.active
        device["member_id"] = None
        assert client.get("/api/notifications/settings").status_code == 403


def test_current_member_required_and_latest_role_is_authoritative(repo, monkeypatch):
    from fastapi import HTTPException

    device = {"device_id": "device", "member_id": 3, "permission": "システム管理者"}
    service.member_identity(device)
    assert device["permission"] == "一般"
    monkeypatch.setattr(repo, "current_owner", lambda *args: None)
    with pytest.raises(HTTPException) as error:
        service.member_identity(device)
    assert error.value.status_code == 403
    monkeypatch.setattr(
        repo,
        "current_owner",
        lambda *args: {"permission": "エキストラ", "system_access_until": "2000-01-01"},
    )
    with pytest.raises(HTTPException):
        service.member_identity(device)


def test_worker_route_is_root_scoped_and_never_cached():
    app = FastAPI()
    app.include_router(notifications.router)
    with TestClient(app) as client:
        response = client.get("/sw.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["service-worker-allowed"] == "/"
    assert "application/javascript" in response.headers["content-type"]


def test_send_uses_timeout_and_disables_redirects(monkeypatch):
    import pywebpush
    import requests

    captured = {}

    def fake_post(self, url, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(status_code=201)

    monkeypatch.setattr(requests.Session, "post", fake_post)

    def fake_webpush(**kwargs):
        captured["push_timeout"] = kwargs["timeout"]
        return kwargs["requests_session"].post(
            kwargs["subscription_info"]["endpoint"], timeout=kwargs["timeout"]
        )

    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "test-only")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:test@example.com")
    assert service.send_push(subscription(), {"title": "通知"}) == 201
    assert captured["push_timeout"] == 5
    assert captured["allow_redirects"] is False


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/x",
        "https://127.0.0.1/x",
        "https://fcm.googleapis.com.evil.example/x",
        "https://evil.push.apple.com.evil.example/x",
        "https://user:pass@fcm.googleapis.com/x",
        "https://fcm.googleapis.com:444/x",
    ],
)
def test_subscription_blocks_untrusted_endpoints(endpoint):
    with pytest.raises(Exception) as error:
        service.validate_subscription({**subscription(), "endpoint": endpoint})
    assert error.value.status_code == 422


@pytest.mark.parametrize("kind", list(NOTIFICATION_TYPES))
def test_eight_kinds_deduplicate_and_keep_payloads_private(repo, kind):
    item = {
        "id": 6,
        "date": "2026-10-18",
        "updated_at": "version-1",
        "content": "PRIVATE",
        "password": "SECRET",
    }
    service.emit(kind, item)
    service.emit(kind, item)
    assert len(repo.events) == 1
    payload = next(iter(repo.events.values()))["payload"]
    assert "2026-10-18" in payload["body"]
    assert "PRIVATE" not in str(payload) and "SECRET" not in str(payload)
    assert payload["target"] == NOTIFICATION_TYPES[kind][1]


@pytest.mark.parametrize("kind", list(NOTIFICATION_TYPES))
def test_server_filters_off_users_and_multidevice_delivery(repo, monkeypatch, kind):
    repo.targets = [
        recipient("a", "システム管理者"),
        recipient("b", "システム管理者"),
        recipient("off", enabled="false"),
        recipient("expired", "エキストラ", until="2000-01-01"),
    ]
    calls = []
    monkeypatch.setattr(service, "send_push", lambda *args: calls.append(args))
    service.emit(kind, {"id": 1})
    service.dispatch_pending("default")
    service.dispatch_pending("default")
    assert len(calls) == 2


def test_admin_only_and_extra_permissions(repo, monkeypatch):
    repo.targets = [
        recipient("general"),
        recipient("admin", "管理者"),
        recipient("system", "システム管理者"),
        recipient("extra", "エキストラ"),
    ]
    monkeypatch.setattr(service, "send_push", lambda *args: None)
    service.emit("improvements", {"id": 1})
    service.dispatch_pending("default")
    assert [sub for _, sub in repo.deliveries] == ["system"]
    assert not service.eligible(recipient("extra", "エキストラ"), "events")


@pytest.mark.parametrize(
    "http_status,result",
    [
        (410, "invalid"),
        (404, "invalid"),
        (429, "retry"),
        (503, "retry"),
        (401, "failed"),
        (None, "unknown"),
    ],
)
def test_push_failure_status_and_invalid_subscription(repo, monkeypatch, http_status, result):
    repo.targets = [recipient()]

    def fail(*args):
        error = RuntimeError("Do not log endpoint SECRET")
        error.response = SimpleNamespace(status_code=http_status)
        raise error

    monkeypatch.setattr(service, "send_push", fail)
    service.emit("notices", {"id": 1})
    service.dispatch_pending("default")
    assert list(repo.deliveries.values()) == [result]
    assert repo.active == (result != "invalid")


def test_tenant_isolation_and_enqueue_failures_do_not_raise(repo, monkeypatch, caplog):
    token = set_current_tenant_id("another-orchestra")
    try:
        service.emit("notices", {"id": 1})
    finally:
        reset_current_tenant_id(token)
    assert not repo.pending("default")
    assert len(repo.pending("another-orchestra")) == 1

    def fail(*args):
        raise RuntimeError("SECRET DB URL")

    monkeypatch.setattr(repo, "enqueue", fail)
    service.emit("notices", {"id": 2})
    assert "SECRET" not in caplog.text


def test_business_save_failure_and_unchanged_schedule_do_not_notify(monkeypatch):
    from src.backend.services import schedule_service

    calls = []
    monkeypatch.setattr(schedule_service, "emit", lambda *args: calls.append(args))
    fake = SimpleNamespace(
        create=lambda payload: {"id": 1, **payload},
        update=lambda item_id, mutate: mutate(
            {"id": item_id, "date": "2026-10-18", "updated_at": "old"}
        ),
    )
    monkeypatch.setattr(schedule_service, "_repo", fake)
    schedule_service.create_schedule({"date": "2026-10-18"})
    schedule_service.update_schedule(1, {"date": "2026-10-18"})
    assert len(calls) == 1
    schedule_service.update_schedule(1, {"date": "2026-10-19"})
    assert len(calls) == 2 and calls[-1][2] == "updated"

    def failed_write(payload):
        raise RuntimeError("save failed")

    fake.create = failed_write
    with pytest.raises(RuntimeError):
        schedule_service.create_schedule({"date": "2026-10-20"})
    assert len(calls) == 2


def test_piece_info_noop_and_failed_save_do_not_notify(monkeypatch):
    from src.backend.services import extra_service

    items = []
    calls = []
    monkeypatch.setattr(extra_service, "load_json_data", lambda name: deepcopy(items))
    monkeypatch.setattr(
        extra_service,
        "save_json_data",
        lambda name, data: items.__setitem__(slice(None), deepcopy(data)),
    )
    monkeypatch.setattr(extra_service, "emit", lambda *args: calls.append(args))
    device = {"permission": "一般", "member_id": 2}
    created = asyncio.run(
        extra_service.create_item("piece_infos", {"piece": "Symphony", "description": "one"}, device)
    )
    asyncio.run(extra_service.update_item("piece_infos", created["id"], created, device))
    assert len(calls) == 1
    asyncio.run(
        extra_service.update_item("piece_infos", created["id"], {**created, "description": "two"}, device)
    )
    assert len(calls) == 2

    def failed_write(name, data):
        raise RuntimeError("save failed")

    monkeypatch.setattr(extra_service, "save_json_data", failed_write)
    with pytest.raises(RuntimeError):
        asyncio.run(extra_service.create_item("piece_infos", {"piece": "Other"}, device))
    assert len(calls) == 2


@pytest.mark.parametrize(
    "module_name,kind",
    [
        ("portal_notice_service", "notices"),
        ("announcement_service", "maintenance"),
        ("event_service", "events"),
        ("improvement_suggestion_service", "improvements"),
    ],
)
def test_creation_hooks_run_after_success_not_after_failure(monkeypatch, module_name, kind):
    from importlib import import_module

    module = import_module("src.backend.services." + module_name)
    calls = []

    def create(*args, **kwargs):
        return {"id": 1, "created_at": "saved"}

    fake = SimpleNamespace(create=create)
    if module_name == "improvement_suggestion_service":
        monkeypatch.setattr(module, "_repository", lambda: fake)

        def call():
            return module.create_member_suggestion("text", {"member_id": 1})
    else:
        monkeypatch.setattr(module, "_repo", fake)
        if module_name == "portal_notice_service":

            def call():
                return module.create_notice(
                    {"date": "2026-10-18"}, {"permission": "一般", "member_id": 1}
                )
        elif module_name == "event_service":

            def call():
                return module.create_event({}, {"member_id": 1})
        else:

            def call():
                return module.create_announcement({})

    monkeypatch.setattr(module, "emit", lambda *args: calls.append(args))
    call()
    assert calls == [(kind, {"id": 1, "created_at": "saved"})]

    def fail(*args, **kwargs):
        raise RuntimeError("failed save")

    fake.create = fail
    with pytest.raises(RuntimeError):
        call()
    assert len(calls) == 1


def test_recording_completion_notifies_once_after_metadata_save(monkeypatch):
    from src.backend.services import recording_upload_service as module

    timeline = []
    item = {"id": "object", "size": 100, "date": "2026-10-18", "modified_at": "generation-one"}
    monkeypatch.setattr(module, "storage_enabled", lambda: True)
    monkeypatch.setattr(module, "recording_item_from_blob", lambda *args, **kwargs: deepcopy(item))
    monkeypatch.setattr(module, "emit", lambda *args: timeline.append("emit"))

    def call(save):
        return module.complete_recording_upload(
            "2026-10-18/Symphony/practice.mp3",
            "practice.mp3",
            "2026-10-18",
            "Symphony",
            100,
            10,
            remember_recording_duration=lambda *args: None,
            remember_drive_file=save,
            format_duration=lambda value: "0:10",
        )

    call(lambda item: timeline.append("save"))
    assert timeline == ["save", "emit"]

    def fail(item):
        raise RuntimeError("save failed")

    with pytest.raises(RuntimeError):
        call(fail)
    assert timeline == ["save", "emit"]


def test_sheet_upload_notifies_only_after_successful_save(monkeypatch, tmp_path):
    from io import BytesIO
    from fastapi import UploadFile
    from src.backend.services import sheet_service as module

    timeline = []
    monkeypatch.setattr(module, "storage_enabled", lambda: False)
    monkeypatch.setattr(module, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(module, "SHEET_DIR", tmp_path / "sheets")
    monkeypatch.setattr(module, "load_json_data", lambda name: [])
    monkeypatch.setattr(module, "save_json_data", lambda *args: timeline.append("save"))
    monkeypatch.setattr(service, "emit", lambda *args: timeline.append("emit"))
    module.upload_sheet_file(
        UploadFile(filename="score.pdf", file=BytesIO(b"%PDF-1.4 test")), "1", "Concert", "Symphony"
    )
    assert timeline == ["save", "emit"]

    def fail(*args):
        raise RuntimeError("save failed")

    monkeypatch.setattr(module, "save_json_data", fail)
    with pytest.raises(RuntimeError):
        module.upload_sheet_file(
            UploadFile(filename="other.pdf", file=BytesIO(b"%PDF-1.4 test")),
            "1",
            "Concert",
            "Symphony",
        )
    assert timeline == ["save", "emit"]


def test_asgi_background_receives_post_save_events(repo, monkeypatch):
    scans = []
    monkeypatch.setattr(service, "dispatch_pending", lambda org: scans.append(org))
    app = FastAPI()

    @app.post("/save")
    def save():
        service.emit("notices", {"id": 1})
        return {"ok": True}

    service.install_notification_middleware(app)
    with TestClient(app) as client:
        assert client.post("/save").json() == {"ok": True}
    assert scans == ["default"]


@pytest.mark.parametrize(
    "method,path,body,authenticated,push_enabled,status,expected",
    [
        ("GET", "/api/notifications/settings", None, True, False, 200, None),
        ("PUT", "/api/notifications/settings", {"preferences": {"notices": False}}, True, False, 200, None),
        ("POST", "/api/notifications/subscriptions", "valid", True, True, 200, {"id": "subscription-id"}),
        ("DELETE", "/api/notifications/subscriptions", None, True, False, 200, {"ok": True}),
        ("GET", "/api/notifications/settings", None, False, False, 401, {"detail": "X-Device-Id is required"}),
        ("PUT", "/api/notifications/settings", {"preferences": {}}, False, False, 401, {"detail": "X-Device-Id is required"}),
        ("POST", "/api/notifications/subscriptions", "valid", False, False, 401, {"detail": "X-Device-Id is required"}),
        ("DELETE", "/api/notifications/subscriptions", None, False, False, 401, {"detail": "X-Device-Id is required"}),
        ("PUT", "/api/notifications/settings", {"preferences": {"improvements": False}}, True, False, 403, {"detail": "システム管理者権限が必要です"}),
        ("PUT", "/api/notifications/settings", {"preferences": {"bogus": True}}, True, False, 422, {"detail": "通知種別が不正です"}),
        ("PUT", "/api/notifications/settings", {"preferences": {"notices": "true"}}, True, False, 422, None),
        ("POST", "/api/notifications/subscriptions", "valid", True, False, 503, {"detail": "プッシュ通知はまだ有効化されていません"}),
    ],
)
def test_notification_middleware_no_store_preserves_http_contract(
    repo, monkeypatch, method, path, body, authenticated, push_enabled, status, expected
):
    from src.backend.core.middleware import configure_middlewares

    # Match application middleware order; repositories stay fake and never open a DB.
    app = configure_middlewares(FastAPI(), environ={})
    app.include_router(notifications.router)
    service.install_notification_middleware(app)
    monkeypatch.setenv("WEB_PUSH_ENABLED", "true" if push_enabled else "false")
    if authenticated:
        app.dependency_overrides[get_device_auth] = lambda: {
            "device_id": "cache-test-device", "member_id": 3, "permission": "一般"
        }
    if body == "valid":
        body = {**subscription(), "permission": "granted"}
    with TestClient(app) as client:
        response = client.request(method, path, **({"json": body} if body is not None else {}))
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"] == "application/json"
    payload = response.json()
    if expected is not None:
        assert payload == expected
    elif status == 422:
        assert payload["detail"][0]["loc"] == ["body", "preferences", "notices"]
        assert payload["detail"][0]["type"] == "bool_type"
    elif method == "GET":
        assert set(payload) == {"preferences", "categories", "configured", "public_key", "subscribed"}
        assert len(payload["preferences"]) == 7
        assert payload["configured"] is False and payload["public_key"] == ""
    else:
        assert set(payload) == {"preferences"}
        assert payload["preferences"]["notices"] is False


def test_notification_cache_policy_does_not_change_other_routes():
    from fastapi.responses import JSONResponse

    app = FastAPI()
    service.install_notification_middleware(app)

    @app.get("/api/notifications-other/probe")
    def unrelated():
        return JSONResponse({"ok": True}, headers={"Cache-Control": "public, max-age=60"})

    with TestClient(app) as client:
        response = client.get("/api/notifications-other/probe")
    assert response.status_code == 200 and response.json() == {"ok": True}
    assert response.headers["cache-control"] == "public, max-age=60"


@pytest.mark.parametrize("handled", [True, False])
def test_notification_500_cache_policy_matches_existing_exception_boundary(handled):
    app = FastAPI()
    service.install_notification_middleware(app)

    @app.get("/api/notifications/failure-probe")
    def failure():
        if handled:
            raise HTTPException(500, "Controlled failure")
        raise RuntimeError("Unhandled failure")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/notifications/failure-probe")
    assert response.status_code == 500
    if handled:
        assert response.json() == {"detail": "Controlled failure"}
        assert response.headers["cache-control"] == "no-store"
    else:
        # ServerErrorMiddleware is outside application middleware; keep that boundary.
        assert response.text == "Internal Server Error"
        assert "cache-control" not in response.headers
