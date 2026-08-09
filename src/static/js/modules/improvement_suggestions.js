// Improvement suggestion UI for members and system administrators.
(function () {
    'use strict';

    var appState = window.portalRuntimeContext.appState;
    var $ = window.portalRuntimeContext.getById;
    var selectedId = null;
    var items = [];

    function escapeText(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function deviceHeaders(json) {
        var headers = {
            'X-Device-Id': localStorage.getItem(window.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || ''
        };
        if (json) headers['Content-Type'] = 'application/json';
        return headers;
    }

    async function api(path, options) {
        var response = await fetch(path, Object.assign({ headers: deviceHeaders(Boolean(options && options.body)) }, options || {}));
        if (!response.ok) {
            var detail = '';
            try {
                var body = await response.json();
                detail = body.detail || '';
            } catch (_) {}
            throw new Error(detail || '処理に失敗しました');
        }
        if (response.status === 204) return null;
        return response.json();
    }

    function ensureMemberPanel() {
        if ($('improvementSuggestionPanel')) return;
        var main = document.querySelector('main.container-fluid');
        if (!main) return;
        main.insertAdjacentHTML('beforeend', `
            <section id="improvementSuggestionPanel" class="panel" hidden>
                <div class="d-flex align-items-center justify-content-between mb-3">
                    <h2 class="h4 mb-0">改善要望受付</h2>
                    <button class="btn btn-sm btn-outline-secondary" id="improvementSuggestionBackBtn" type="button">ポータルへ戻る</button>
                </div>
                <div class="card mb-4">
                    <div class="card-header">改善要望受付</div>
                    <div class="card-body">
                        <label class="form-label" for="improvementSuggestionText">改善案</label>
                        <textarea class="form-control" id="improvementSuggestionText" rows="4" maxlength="2000"></textarea>
                        <div class="mt-3">
                            <button class="btn btn-primary" id="improvementSuggestionRegisterBtn" type="button">登録</button>
                        </div>
                    </div>
                </div>
                <div class="row g-4">
                    <div class="col-12 col-xl-6">
                        <div class="card h-100">
                            <div class="card-header">未対応</div>
                            <div class="card-body" id="improvementSuggestionPendingList"></div>
                        </div>
                    </div>
                    <div class="col-12 col-xl-6">
                        <div class="card h-100">
                            <div class="card-header">対応済み</div>
                            <div class="card-body" id="improvementSuggestionCompletedList"></div>
                        </div>
                    </div>
                </div>
            </section>
        `);
        $('improvementSuggestionBackBtn').addEventListener('click', function () {
            $('improvementSuggestionPanel').hidden = true;
            if ($('memberPanel')) $('memberPanel').hidden = false;
            if (typeof switchTab === 'function') switchTab('memberPanel', 'member-home');
            window.scrollTo({ top: 0, behavior: 'auto' });
        });
        $('improvementSuggestionRegisterBtn').addEventListener('click', registerMemberSuggestion);
    }

    function ensureSystemPanel() {
        var panel = $('systemPanel');
        if (!panel || $('systemImprovementSuggestionTab')) return;
        var toolbar = panel.querySelector('.toolbar');
        if (toolbar && !toolbar.querySelector('[data-tab="system-improvement-suggestion"]')) {
            toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" data-tab="system-improvement-suggestion" type="button">改善案管理</button>');
        }
        panel.insertAdjacentHTML('beforeend', `
            <div id="systemImprovementSuggestionTab" class="tab-content" hidden>
                <div class="card mb-4">
                    <div class="card-header">改善案管理</div>
                    <div class="card-body">
                        <input type="hidden" id="systemImprovementSuggestionId">
                        <div class="mb-3">
                            <label class="form-label" for="systemImprovementSuggestionText">改善案</label>
                            <textarea class="form-control" id="systemImprovementSuggestionText" rows="4" maxlength="2000"></textarea>
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="systemImprovementSuggestionResolution">修正内容</label>
                            <textarea class="form-control" id="systemImprovementSuggestionResolution" rows="4" maxlength="4000"></textarea>
                        </div>
                        <div class="row g-3 mb-3">
                            <div class="col-md-8">
                                <label class="form-label d-block">ステータス</label>
                                <div class="d-flex flex-wrap gap-3">
                                    <label class="form-check"><input class="form-check-input" type="radio" name="systemImprovementSuggestionStatus" value="未対応" checked><span class="form-check-label">未対応</span></label>
                                    <label class="form-check"><input class="form-check-input" type="radio" name="systemImprovementSuggestionStatus" value="修正中"><span class="form-check-label">修正中</span></label>
                                    <label class="form-check"><input class="form-check-input" type="radio" name="systemImprovementSuggestionStatus" value="対応済"><span class="form-check-label">対応済</span></label>
                                </div>
                            </div>
                            <div class="col-md-4">
                                <label class="form-label" for="systemImprovementSuggestionRespondedAt">対応日</label>
                                <input class="form-control" id="systemImprovementSuggestionRespondedAt" type="date">
                            </div>
                        </div>
                        <div class="d-flex flex-wrap gap-2">
                            <button class="btn btn-success" id="systemImprovementSuggestionRegisterBtn" type="button">登録</button>
                            <button class="btn btn-primary" id="systemImprovementSuggestionEditBtn" type="button" disabled>編集</button>
                            <button class="btn btn-danger" id="systemImprovementSuggestionDeleteBtn" type="button" disabled>削除</button>
                            <button class="btn btn-outline-secondary" id="systemImprovementSuggestionClearBtn" type="button">選択解除</button>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header">改善案一覧</div>
                    <div class="card-body" id="systemImprovementSuggestionList"></div>
                </div>
            </div>
        `);
        $('systemImprovementSuggestionRegisterBtn').addEventListener('click', function () { saveAdminSuggestion(false); });
        $('systemImprovementSuggestionEditBtn').addEventListener('click', function () { saveAdminSuggestion(true); });
        $('systemImprovementSuggestionDeleteBtn').addEventListener('click', deleteAdminSuggestion);
        $('systemImprovementSuggestionClearBtn').addEventListener('click', clearAdminForm);
        panel.querySelector('[data-tab="system-improvement-suggestion"]').addEventListener('click', function () {
            if (typeof switchTab === 'function') switchTab('systemPanel', 'system-improvement-suggestion', false);
            loadSuggestions().catch(showError);
        });
    }

    function formatDateTime(value) {
        if (!value) return '';
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('ja-JP');
    }

    function memberCard(item, completed) {
        var extra = completed
            ? '<div class="small mt-2"><strong>修正内容:</strong> ' + escapeText(item.resolution || '-') + '</div><div class="small"><strong>対応日:</strong> ' + escapeText(item.responded_at || '-') + '</div>'
            : '';
        return '<div class="border rounded p-3 mb-2">' +
            '<div class="d-flex justify-content-between gap-2"><strong>' + escapeText(item.suggestion) + '</strong><span class="badge text-bg-secondary">' + escapeText(item.status) + '</span></div>' +
            '<div class="text-muted small mt-1">' + escapeText(formatDateTime(item.created_at)) + '</div>' +
            extra + '</div>';
    }

    function renderMemberLists() {
        var pending = items.filter(function (item) { return item.status === '未対応' || item.status === '修正中'; });
        var completed = items.filter(function (item) { return item.status === '対応済'; });
        $('improvementSuggestionPendingList').innerHTML = pending.length ? pending.map(function (item) { return memberCard(item, false); }).join('') : '<p class="text-muted mb-0">未対応の改善案はありません。</p>';
        $('improvementSuggestionCompletedList').innerHTML = completed.length ? completed.map(function (item) { return memberCard(item, true); }).join('') : '<p class="text-muted mb-0">対応済みの改善案はありません。</p>';
    }

    function renderSystemList() {
        var target = $('systemImprovementSuggestionList');
        if (!target) return;
        if (!items.length) {
            target.innerHTML = '<p class="text-muted mb-0">改善案はありません。</p>';
            return;
        }
        target.innerHTML = '<div class="table-responsive"><table class="table table-sm table-hover align-middle"><thead><tr><th>登録日</th><th>登録者</th><th>改善案</th><th>ステータス</th><th>修正内容</th><th>対応日</th></tr></thead><tbody>' +
            items.map(function (item) {
                return '<tr class="improvement-suggestion-row" data-id="' + item.id + '" role="button"><td>' + escapeText(formatDateTime(item.created_at)) + '</td><td>' + escapeText(item.registered_by) + '</td><td>' + escapeText(item.suggestion) + '</td><td>' + escapeText(item.status) + '</td><td>' + escapeText(item.resolution || '') + '</td><td>' + escapeText(item.responded_at || '') + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        target.querySelectorAll('.improvement-suggestion-row').forEach(function (row) {
            row.addEventListener('click', function () { selectAdminSuggestion(Number(row.dataset.id)); });
        });
    }

    async function loadSuggestions() {
        items = await api('/api/improvement-suggestions');
        if ($('improvementSuggestionPanel')) renderMemberLists();
        if ($('systemImprovementSuggestionList')) renderSystemList();
    }

    async function registerMemberSuggestion() {
        var text = $('improvementSuggestionText').value.trim();
        if (!text) {
            showError(new Error('改善案を入力してください'));
            return;
        }
        await api('/api/improvement-suggestions', { method: 'POST', body: JSON.stringify({ suggestion: text }) });
        $('improvementSuggestionText').value = '';
        await loadSuggestions();
        if (typeof showAlert === 'function') showAlert('改善案を登録しました', 'success');
    }

    function adminPayload() {
        var selectedStatus = document.querySelector('input[name="systemImprovementSuggestionStatus"]:checked');
        return {
            suggestion: $('systemImprovementSuggestionText').value.trim(),
            resolution: $('systemImprovementSuggestionResolution').value.trim(),
            status: selectedStatus ? selectedStatus.value : '未対応',
            responded_at: $('systemImprovementSuggestionRespondedAt').value || null
        };
    }

    async function saveAdminSuggestion(editing) {
        var payload = adminPayload();
        if (!payload.suggestion) {
            showError(new Error('改善案を入力してください'));
            return;
        }
        if (editing) {
            if (!selectedId) return;
            await api('/api/system/improvement-suggestions/' + selectedId, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
            await api('/api/system/improvement-suggestions', { method: 'POST', body: JSON.stringify(payload) });
        }
        clearAdminForm();
        await loadSuggestions();
        if (typeof showAlert === 'function') showAlert(editing ? '改善案を編集しました' : '改善案を登録しました', 'success');
    }

    async function deleteAdminSuggestion() {
        if (!selectedId) return;
        if (!window.confirm('選択した改善案を削除しますか？')) return;
        await api('/api/system/improvement-suggestions/' + selectedId, { method: 'DELETE' });
        clearAdminForm();
        await loadSuggestions();
        if (typeof showAlert === 'function') showAlert('改善案を削除しました', 'success');
    }

    function selectAdminSuggestion(id) {
        var item = items.find(function (candidate) { return Number(candidate.id) === Number(id); });
        if (!item) return;
        selectedId = Number(item.id);
        $('systemImprovementSuggestionId').value = String(item.id);
        $('systemImprovementSuggestionText').value = item.suggestion || '';
        $('systemImprovementSuggestionResolution').value = item.resolution || '';
        $('systemImprovementSuggestionRespondedAt').value = item.responded_at || '';
        var radio = document.querySelector('input[name="systemImprovementSuggestionStatus"][value="' + item.status + '"]');
        if (radio) radio.checked = true;
        $('systemImprovementSuggestionEditBtn').disabled = false;
        $('systemImprovementSuggestionDeleteBtn').disabled = false;
    }

    function clearAdminForm() {
        selectedId = null;
        if (!$('systemImprovementSuggestionText')) return;
        $('systemImprovementSuggestionId').value = '';
        $('systemImprovementSuggestionText').value = '';
        $('systemImprovementSuggestionResolution').value = '';
        $('systemImprovementSuggestionRespondedAt').value = '';
        var pending = document.querySelector('input[name="systemImprovementSuggestionStatus"][value="未対応"]');
        if (pending) pending.checked = true;
        $('systemImprovementSuggestionEditBtn').disabled = true;
        $('systemImprovementSuggestionDeleteBtn').disabled = true;
    }

    function showError(error) {
        console.warn('[改善案]', error);
        if (typeof showAlert === 'function') showAlert(error && error.message ? error.message : '処理に失敗しました', 'warning');
    }

    async function showImprovementSuggestions() {
        ensureMemberPanel();
        if ($('adminPanel')) $('adminPanel').hidden = true;
        if ($('systemPanel')) $('systemPanel').hidden = true;
        if ($('memberPanel')) $('memberPanel').hidden = true;
        $('improvementSuggestionPanel').hidden = false;
        window.scrollTo({ top: 0, behavior: 'auto' });
        try {
            await loadSuggestions();
        } catch (error) {
            showError(error);
        }
    }

    function init() {
        ensureMemberPanel();
        ensureSystemPanel();
        document.querySelectorAll('[data-improvement-suggestion-open]').forEach(function (button) {
            button.addEventListener('click', showImprovementSuggestions);
        });
    }

    window.showImprovementSuggestions = showImprovementSuggestions;
    window.loadImprovementSuggestions = loadSuggestions;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
