// Notification settings use the same member tabs and request authentication as the portal.
(function (global) {
    'use strict';
    const state = () => global.portalRuntimeContext.appState;
    const byId = (id) => document.getElementById(id);
    let registrationPromise;
    let savedSettings = null;
    let renderVersion = 0;
    const targets = new Set(['notice-history', 'member-schedule', 'member-recording', 'member-piece-info',
        'member-sheet', 'member-event', 'maintenance-history', 'system-improvement-suggestion']);

    function capabilities() {
        const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const standalone = global.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
        if (ios && !standalone) return 'iPhone・iPadはiOS 16.4以降で、ホーム画面に追加したアプリから通知を許可してください。';
        if (!global.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in global) || !('Notification' in global)) return 'このブラウザではプッシュ通知を利用できません。HTTPSの対応ブラウザをご利用ください。';
        return '';
    }

    function registration() {
        if (!registrationPromise) {
            registrationPromise = navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
                .then(() => navigator.serviceWorker.ready)
                .catch((error) => { registrationPromise = null; throw error; });
        }
        return registrationPromise;
    }

    function ensurePanel() {
        if (byId('notificationSettingsTab')) return;
        byId('memberPanel')?.insertAdjacentHTML('beforeend', `
            <div id="notificationSettingsTab" class="tab-content" hidden>
                <div class="card"><div class="card-header">通知設定</div><div class="card-body">
                    <button class="btn btn-sm btn-outline-secondary mb-3" id="notificationBackBtn" type="button">ポータルメニューに戻る</button>
                    <p id="notificationStatus" role="status" aria-live="polite">通知設定を読み込み中...</p>
                    <div class="d-flex flex-wrap gap-2 mb-3">
                        <button class="btn btn-primary" id="notificationEnableBtn" type="button" disabled>この端末で通知を許可する</button>
                        <button class="btn btn-outline-secondary" id="notificationDisableBtn" type="button" disabled>この端末の通知を停止する</button>
                    </div>
                    <p class="small text-muted">通知の種類は団員ごとに保存されます。受信の許可・停止はこの端末だけに適用されます。</p>
                    <form id="notificationSettingsForm"><div id="notificationCategories"></div>
                        <button class="btn btn-success mt-3" type="submit" id="notificationSaveBtn" disabled>設定を保存する</button>
                    </form>
                </div></div>
            </div>`);
        byId('notificationBackBtn').onclick = () => showMemberTab('member-home');
        byId('notificationSettingsForm').onsubmit = save;
        byId('notificationEnableBtn').onclick = enable;
        byId('notificationDisableBtn').onclick = async () => {
            await operate(async () => { await disable(); await render(); });
        };
    }

    function showStatus(text) { if (byId('notificationStatus')) byId('notificationStatus').textContent = text; }

    async function render() {
        const version = ++renderVersion;
        const memberId = state().currentUserMemberId;
        ensurePanel();
        savedSettings = null;
        byId('notificationCategories').replaceChildren();
        for (const id of ['notificationSaveBtn', 'notificationEnableBtn', 'notificationDisableBtn']) byId(id).disabled = true;
        showStatus('通知設定を読み込み中...');
        if (!state().currentUserMemberId) { showStatus('通知設定には団員アカウントでログインしてください。'); return; }
        try {
            // Never render cached settings as a successful fresh DB read.
            const result = await request('/api/notifications/settings', { _forceRevalidate: true, _allowCacheFallback: false });
            if (version !== renderVersion || memberId !== state().currentUserMemberId) return;
            savedSettings = result;
            for (const [key, label] of Object.entries(result.categories)) {
                if (key === 'improvements' && state().currentUserPermission !== 'システム管理者') continue;
                const row = document.createElement('div');
                row.className = 'form-check form-switch mb-3';
                const input = document.createElement('input');
                input.type = 'checkbox'; input.className = 'form-check-input'; input.id = `notification-${key}`;
                input.dataset.notificationKind = key; input.checked = result.preferences[key] === true;
                const labelElement = document.createElement('label');
                labelElement.className = 'form-check-label'; labelElement.htmlFor = input.id; labelElement.textContent = label;
                row.append(input, labelElement); byId('notificationCategories').append(row);
            }
            byId('notificationSaveBtn').disabled = false;
            const unsupported = capabilities();
            if (unsupported) { showStatus(unsupported); return; }
            if (!result.configured) { showStatus('プッシュ通知はまだ有効化されていません。通知の種類は保存できます。'); return; }
            if (Notification.permission === 'denied') { showStatus('ブラウザで通知が拒否されています。端末・ブラウザの設定から許可してください。'); return; }
            const reg = await registration();
            const sub = await reg.pushManager.getSubscription();
            const active = Notification.permission === 'granted' && !!sub && keyMatches(sub, result.public_key) && result.subscribed;
            showStatus(active ? 'この端末で通知を受信できます。' : 'この端末では通知を受信していません。「通知を許可する」を押してください。');
            byId('notificationEnableBtn').disabled = active;
            byId('notificationDisableBtn').disabled = !sub && !result.subscribed;
        } catch { showStatus('通知設定を取得できませんでした。もう一度この画面を開いてください。'); }
    }

    async function operate(action) {
        try { await action(); }
        catch { showStatus('処理に失敗しました。設定は保存済みとして扱われません。もう一度お試しください。'); }
    }

    async function save(event) {
        event.preventDefault();
        const preferences = {};
        byId('notificationCategories').querySelectorAll('[data-notification-kind]').forEach((input) => {
            preferences[input.dataset.notificationKind] = input.checked;
        });
        byId('notificationSaveBtn').disabled = true;
        try {
            const result = await request('/api/notifications/settings', jsonOptions('PUT', { preferences }));
            savedSettings.preferences = result.preferences;
            showStatus('通知の種類を保存しました。');
        } catch { showStatus('保存できませんでした。変更は保存されていません。もう一度保存してください。'); }
        finally { byId('notificationSaveBtn').disabled = false; }
    }

    function keyBytes(key) {
        const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
        return Uint8Array.from(raw, (character) => character.charCodeAt(0));
    }

    function keyMatches(subscription, key) {
        const expected = keyBytes(key);
        const actual = new Uint8Array(subscription.options?.applicationServerKey || []);
        return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
    }

    async function enable() {
        if (!savedSettings?.configured || capabilities()) return;
        byId('notificationEnableBtn').disabled = true;
        // Permission must be requested directly from the click, before an async network call.
        const permissionPromise = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
        let refreshed = false;
        await operate(async () => {
            if (await permissionPromise !== 'granted') { await render(); refreshed = true; return; }
            const reg = await registration();
            let sub = await reg.pushManager.getSubscription();
            if (sub && !keyMatches(sub, savedSettings.public_key)) {
                await sub.unsubscribe();
                sub = null;
            }
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(savedSettings.public_key) });
            await request('/api/notifications/subscriptions', jsonOptions('POST', { ...sub.toJSON(), permission: 'granted' }));
            localStorage.setItem('portalPushMemberId', String(state().currentUserMemberId));
            await render();
            refreshed = true;
        });
        if (!refreshed && byId('notificationEnableBtn')) byId('notificationEnableBtn').disabled = false;
    }

    async function disable() {
        // Unsubscribe locally even if the server is temporarily unreachable.
        let serverError;
        try { await request('/api/notifications/subscriptions', { method: 'DELETE' }); }
        catch (error) { serverError = error; }
        if (!capabilities()) {
            const reg = await navigator.serviceWorker.getRegistration('/');
            const sub = await reg?.pushManager.getSubscription();
            if (sub && !await sub.unsubscribe()) throw new Error('unsubscribe failed');
        }
        localStorage.removeItem('portalPushMemberId');
        if (serverError) throw serverError;
    }

    async function beforeLogout() {
        if (!localStorage.getItem('portalPushMemberId')) return;
        try { await disable(); }
        catch { showAlert('端末の通知停止を確認できませんでした。ブラウザの通知設定も確認してください。', 'warning'); }
    }

    async function restoreTarget() {
        const url = new URL(global.location.href);
        const target = url.searchParams.get('notification');
        if (!target || !state().portalAuthVerified || !targets.has(target)) return;
        // Recheck current account access; an external URL can never become a navigation target.
        if (target === 'member-event' && state().currentUserPermission === 'エキストラ') return;
        if (target === 'system-improvement-suggestion') {
            if (state().currentUserPermission !== 'システム管理者') return;
            await showSystemPanel();
            const button = document.querySelector('[data-tab="system-improvement-suggestion"]');
            button?.click();
        } else if (target === 'notice-history') {
            await openPortalNoticeHistory();
        } else if (target === 'maintenance-history') {
            openMaintenanceHistory();
        } else {
            await showMemberTab(target);
        }
        url.searchParams.delete('notification');
        global.history.replaceState(global.history.state, '', url.href);
    }

    global.PortalNotifications = { render, capabilities, beforeLogout, restoreTarget };
})(window);
