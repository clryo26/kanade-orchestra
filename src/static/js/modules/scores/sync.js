// Sheet library synchronization (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, sections 3-4).
//
// - The server's list version (one number in the DB per organization) is
//   checked when a library tab opens, when the portal comes back, when 更新
//   is pressed and about every 5 s while a library tab is shown. The list is
//   fetched only when the version changed (or on 更新).
// - Responses are applied only when they are newer than what is shown: by
//   request number, by list version and for the same account. Old responses,
//   failures and cached copies never count as a successful update.
// - Only one check runs at a time; nothing runs while no library tab is shown,
//   the page is hidden, or nobody is signed in.
// - An automatic update keeps filters, open sections and the scroll position,
//   and never touches an open PDF. Push notifications are not used for this.
(function (root) {
    'use strict';

    var POLL_MS = 5000;
    var BACKOFF_MS = [5000, 10000, 20000, 30000];
    var TABS = ['memberSheetTab', 'sheetAdminTab'];

    var api = function () { return root.portalSheetApi; };
    var state = function () { return window.portalRuntimeContext.appState; };
    var byId = function (id) {
        var ctx = window.portalRuntimeContext;
        return ctx && typeof ctx.getById === 'function' ? ctx.getById(id) : document.getElementById(id);
    };

    var sync = {
        timer: null,
        checking: null,
        requestSeq: 0,
        appliedSeq: 0,
        failures: 0,
        lastOkAt: 0,
        lastError: '',
        account: '',
        listeners: false,
        notice: '',
    };

    function visibleTab() {
        if (document.visibilityState === 'hidden') return null;
        for (var i = 0; i < TABS.length; i += 1) {
            var tab = byId(TABS[i]);
            if (tab && !tab.hidden && tab.offsetParent !== null) return TABS[i];
        }
        return null;
    }

    function signedIn() {
        var s = state();
        return Boolean(s.portalAuthVerified && api() && api().deviceId());
    }

    function time(ts) {
        var d = new Date(ts + 9 * 3600000);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    }

    // The bar above both lists: update button, last update, failure + retry.
    function renderStatus(mode) {
        ['memberSheetSync', 'sheetAdminSync'].forEach(function (id) {
            var bar = byId(id);
            if (!bar) return;
            var busy = mode === 'loading';
            var text;
            var tone = 'text-muted';
            if (sync.lastError) {
                tone = 'text-danger';
                text = '一覧を更新できませんでした（' + sync.lastError + '）。' +
                    (sync.lastOkAt ? '表示中の一覧は ' + time(sync.lastOkAt) + ' 時点のものです。' : '表示中の一覧は最新ではない可能性があります。');
            } else if (busy) {
                text = '一覧を確認しています...';
            } else if (sync.lastOkAt) {
                text = '最終確認 ' + time(sync.lastOkAt);
            } else {
                text = '';
            }
            bar.innerHTML = '<div class="d-flex flex-wrap align-items-center gap-2 mb-2">' +
                '<button class="btn btn-sm btn-outline-primary sheet-sync-refresh" type="button"' + (busy ? ' disabled' : '') + '>' +
                (busy ? '確認中...' : '更新') + '</button>' +
                (sync.lastError ? '<button class="btn btn-sm btn-primary sheet-sync-retry" type="button">再試行</button>' : '') +
                '<span class="small ' + tone + '" role="status" aria-live="polite"></span></div>' +
                (sync.notice ? '<div class="alert alert-info py-2 small mb-2 sheet-sync-notice"></div>' : '');
            bar.querySelector('[role=status]').textContent = text;
            if (sync.notice) bar.querySelector('.sheet-sync-notice').textContent = sync.notice;
            bar.querySelectorAll('.sheet-sync-refresh, .sheet-sync-retry').forEach(function (button) {
                button.addEventListener('click', function () { refreshSheetLibrary({ force: true, reason: 'button' }); });
            });
        });
    }

    // Keeps the open sections and the scroll position over a re-render.
    function preserveView(render) {
        var container = byId('memberSheetInfo');
        var open = [];
        if (container) {
            Array.prototype.forEach.call(container.querySelectorAll('details[data-sheet-key]'), function (el) {
                if (el.open) open.push(el.dataset.sheetKey);
            });
        }
        var scrollY = window.scrollY;
        var hadState = container && container.dataset.rendered === '1';
        render();
        if (container && hadState) {
            Array.prototype.forEach.call(container.querySelectorAll('details[data-sheet-key]'), function (el) {
                el.open = open.indexOf(el.dataset.sheetKey) >= 0;
            });
        }
        if (container) container.dataset.rendered = '1';
        if (Math.abs(window.scrollY - scrollY) > 1) window.scrollTo(0, scrollY);
    }

    // reset: the server's number went below the shown one (DB restored or
    // synchronized from production): the server's list is taken as it is.
    function apply(payload, seq, reset) {
        var s = state();
        var version = Number(payload.list_version || 0);
        // Older than what is shown (a slow response overtaken by a newer one).
        if (seq < sync.appliedSeq) return false;
        if (!reset && s.sheetListVersion != null && version < Number(s.sheetListVersion)) return false;
        sync.appliedSeq = seq;
        s.sheetListVersion = version;
        s.sheetLibrary = Array.isArray(payload.files) ? payload.files : [];
        s.sheetsLoaded = true;
        var known = new Set(s.sheetLibrary.map(function (f) { return String(f.id); }));
        s.selectedSheetIds = (s.selectedSheetIds || []).filter(function (id) { return known.has(String(id)); });
        preserveView(function () {
            if (typeof renderSheetLibraryView === 'function') renderSheetLibraryView();
        });
        if (typeof renderSheetAdminList === 'function' && byId('sheetAdminList')) renderSheetAdminList();
        return true;
    }

    async function loadList(reset) {
        var seq = ++sync.requestSeq;
        var result = await api().call('/api/sheets');
        if (result.status !== 200 || !result.data || !Array.isArray(result.data.files)) {
            throw api().SheetApiError(api().detailMessage(result.data, 'サーバーの応答が正しくありません'), { kind: 'http', status: result.status });
        }
        apply(result.data, seq, reset);
        return result.data;
    }

    // force: fetch the list even if the version did not change (更新).
    async function refreshSheetLibrary(options) {
        var o = options || {};
        if (!signedIn()) return { ok: false, reason: 'signed-out' };
        if (sync.account !== api().accountKey()) resetSheetLibrarySync('account-changed');
        if (sync.checking && !o.force) return sync.checking;
        renderStatus('loading');
        var run = (async function () {
            try {
                var shown = state().sheetListVersion;
                var changed = true;
                var reset = Boolean(o.force);
                if (!o.force && shown != null) {
                    var v = await api().call('/api/sheets/version');
                    if (v.status !== 200 || !v.data) throw api().SheetApiError(api().detailMessage(v.data, '確認できませんでした'), { kind: 'http', status: v.status });
                    noticeRelease(v.data);
                    changed = Number(v.data.list_version) !== Number(shown);
                    reset = Number(v.data.list_version) < Number(shown);
                }
                // 更新 always takes the server's list (newest request wins).
                if (changed) await loadList(reset);
                sync.lastOkAt = Date.now();
                sync.lastError = '';
                sync.failures = 0;
                return { ok: true, changed: changed };
            } catch (error) {
                if (error && error.kind === 'account') return { ok: false, reason: 'account' };
                sync.failures += 1;
                sync.lastError = error && error.kind === 'timeout' ? '通信がタイムアウトしました'
                    : error && error.kind === 'network' ? '通信できませんでした'
                        : (error && error.message) || '不明なエラー';
                return { ok: false, reason: error && error.kind, message: sync.lastError };
            } finally {
                renderStatus();
            }
        })();
        if (!o.force) sync.checking = run;
        try {
            return await run;
        } finally {
            if (sync.checking === run) sync.checking = null;
        }
    }

    // A newer server release: shown as a notice only. Reloading is the
    // user's choice and is never done while an upload or a save is running.
    function noticeRelease(data) {
        var loaded = state().cloudRunRevision || '';
        var latest = data && data.release ? String(data.release) : '';
        var next = loaded && latest && latest !== loaded
            ? '新しい版が公開されています。登録や保存が終わったら、画面を再読み込みしてください。' : '';
        if (next !== sync.notice) {
            sync.notice = next;
            renderStatus();
        }
    }

    function schedule() {
        clearTimeout(sync.timer);
        sync.timer = null;
        if (!visibleTab() || !signedIn()) return;
        var delay = sync.failures ? BACKOFF_MS[Math.min(sync.failures, BACKOFF_MS.length) - 1] : POLL_MS;
        sync.timer = setTimeout(function () {
            sync.timer = null;
            if (!visibleTab() || !signedIn()) return; // left the screen meanwhile
            refreshSheetLibrary({ reason: 'poll' }).then(schedule, schedule);
        }, delay);
    }

    function onReturn() {
        if (!visibleTab() || !signedIn()) {
            clearTimeout(sync.timer);
            sync.timer = null;
            return;
        }
        refreshSheetLibrary({ reason: 'return' }).then(schedule, schedule);
    }

    function bindListeners() {
        if (sync.listeners) return;
        sync.listeners = true;
        document.addEventListener('visibilitychange', onReturn);
        window.addEventListener('pageshow', onReturn);
        window.addEventListener('online', onReturn);
    }

    // Called when a library tab is shown.
    function startSheetLibrarySync() {
        bindListeners();
        if (sync.account !== api().accountKey()) resetSheetLibrarySync('account-changed');
        sync.account = api().accountKey();
        renderStatus();
        return refreshSheetLibrary({ reason: 'open', force: state().sheetListVersion == null }).then(function (r) {
            schedule();
            return r;
        });
    }

    // Logout / account switch: stop everything, forget in-flight results.
    function resetSheetLibrarySync() {
        clearTimeout(sync.timer);
        sync.timer = null;
        sync.checking = null;
        sync.requestSeq += 1;
        sync.appliedSeq = sync.requestSeq;
        sync.failures = 0;
        sync.lastOkAt = 0;
        sync.lastError = '';
        sync.account = api() ? api().accountKey() : '';
        var s = state();
        s.sheetListVersion = null;
    }

    root.startSheetLibrarySync = startSheetLibrarySync;
    root.refreshSheetLibrary = refreshSheetLibrary;
    root.resetSheetLibrarySync = resetSheetLibrarySync;
    root.portalSheetSync = { state: sync, apply: apply, POLL_MS: POLL_MS, visibleTab: visibleTab };
})(typeof globalThis !== 'undefined' ? globalThis : window);
