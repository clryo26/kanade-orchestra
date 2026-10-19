// Durable operation identity for the newly assetized APIs only (JST R05-A/B).
// Store hashes/IDs, never form data, credentials, or attachments. After a reload
// the original attachment must be selected again; status queries need no file.
(function (root) {
    'use strict';
    const STORAGE = 'portalFileOperations:v1';
    const running = new Map();
    const actorScopes = new Map();
    const identity = () => typeof root.portalCacheIdentity === 'function' ? root.portalCacheIdentity() : '';
    const read = () => {
        const value = JSON.parse(localStorage.getItem(STORAGE) || '{}');
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('保存操作の記録を読み込めません');
        return value;
    };
    const write = (records) => localStorage.setItem(STORAGE, JSON.stringify(records));
    async function digest(value) {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : await value.arrayBuffer();
        const result = await root.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    function stable(value) {
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
        return value;
    }
    async function fingerprint(url, options) {
        let body;
        if (options.body instanceof FormData) {
            body = await Promise.all(Array.from(options.body.entries(), async ([key, value]) => [key,
                typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size, sha256: await digest(value) }]));
            body.sort((a, b) => a[0].localeCompare(b[0]));
        } else {
            try { body = stable(JSON.parse(options.body || '{}')); } catch { body = options.body || ''; }
        }
        return digest(JSON.stringify([options.method || 'POST', url, body]));
    }
    async function send(url, options, owner) {
        if (owner !== identity()) throw new Error('認証情報が変わりました。元のアカウントで操作結果を確認してください');
        const device = localStorage.getItem(root.portalRuntimeContext.PORTAL_DEVICE_ID_KEY) || '';
        const response = await root.fetchWithTimeout(url, {
            ...options, cache: 'no-store', headers: { ...options.headers, 'X-Device-Id': device },
        }, 120000);
        if (owner !== identity()) throw new Error('認証情報が変わりました。元のアカウントで操作結果を確認してください');
        const data = await response.json();
        if (owner !== identity()) throw new Error('認証情報が変わりました。元のアカウントで操作結果を確認してください');
        return { status: response.status, data };
    }
    async function accountScope(owner) {
        const result = await send('/api/portal-file-actor', { method: 'GET' }, owner);
        if (result.status !== 200 || !/^[a-f0-9]{64}$/.test(result.data.scope || '')) {
            throw new Error('操作主体を確認できません。再ログインして再試行してください');
        }
        if (actorScopes.has(owner) && actorScopes.get(owner) !== result.data.scope) {
            throw new Error('アカウント情報が変わりました。再ログインしてから操作してください');
        }
        actorScopes.set(owner, result.data.scope);
        return result.data.scope;
    }
    async function query(record, owner) {
        const result = await send(`/api/portal-file-operations/${encodeURIComponent(record.id)}`, { method: 'GET' }, owner);
        if (result.status === 200 && Number.isInteger(result.data.result_status)) {
            return { status: result.data.result_status, data: result.data.result_body };
        }
        // 404 is an authoritative "not accepted" only when the endpoint
        // actually answered. Network/DB errors must never take this branch.
        if (result.status === 404 && result.data.code === 'file_operation_unknown') return null;
        if (result.status === 202) return result;
        throw new Error(result.data.detail?.message || result.data.detail || '操作結果を確認できません。再度確認してください');
    }
    function unresolved(result) {
        return result.status === 202 || result.status >= 500 || result.data?.detail?.code === 'file_operation_expired';
    }
    function notice(message, record, owner) {
        let box = document.getElementById('portalFileOperationStatus');
        if (!box) {
            box = document.createElement('div');
            box.id = 'portalFileOperationStatus';
            box.className = 'm-3';
            box.setAttribute('role', 'status');
            document.body.appendChild(box);
        }
        let row = document.getElementById(`portalFileOperation-${record.id}`);
        if (!row) {
            row = document.createElement('div'); row.id = `portalFileOperation-${record.id}`;
            row.className = 'alert alert-warning'; box.appendChild(row);
        }
        row.replaceChildren(document.createTextNode(message + ' '));
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn btn-outline-secondary btn-sm'; button.textContent = '操作結果を確認';
        button.onclick = async () => {
            button.disabled = true;
            try {
                const result = await query(record, owner);
                notice(result && !unresolved(result)
                    ? (result.status < 400 ? '処理は完了しました。同じ内容で保存すると結果を画面に反映します。' : '処理は終了しました。同じ内容で保存すると結果を表示します。')
                    : 'まだ結果が確定していません。添付ファイルを含め、同じ内容で再試行してください。', record, owner);
            } catch (error) { notice(error.message, record, owner); }
        };
        row.appendChild(button);
    }
    async function perform(url, options, hash, owner, scope) {
        const slot = await digest(JSON.stringify([scope, options.method || 'POST', url]));
        if (owner !== identity()) throw new Error('認証情報が変わりました。再読み込みしてください');
        const records = read();
        let record = records[slot];
        let result = null;
        if (record) {
            result = await query(record, owner);
            if (record.hash !== hash) {
                if (!result || unresolved(result)) {
                    notice('前の保存結果を確認してください。結果不明のまま別の内容を送信できません。', record, owner);
                    throw new Error('前の保存内容に戻すか、操作結果を確認してください');
                }
                record = null; result = null;
            }
        }
        if (!record) {
            record = { id: root.crypto.randomUUID(), hash, ownerHash: scope };
            records[slot] = record;
            write(records); // Durable before sending; storage failure stops upload.
        }
        try {
            if (!result || result.status === 202) {
                result = await send(url, { ...options, headers: { ...options.headers, 'Idempotency-Key': record.id } }, owner);
            }
            if (unresolved(result)) throw new Error(result.data?.detail?.code === 'file_operation_expired'
                ? '結果の保存期間を過ぎています。新しい操作で保存し直す前に、現在のデータを確認してください'
                : '保存結果を確認しています。内容を変えずに再試行してください');
            if (result.status >= 400) {
                // Deterministic rejection: known result, a new user action may
                // correct it. Retain unknown outcomes on every other path.
                const error = new Error(result.data.detail?.message || result.data.detail || '保存できませんでした');
                error.terminal = true;
                throw error;
            }
            const latest = read(); delete latest[slot]; write(latest);
            document.getElementById(`portalFileOperation-${record.id}`)?.remove();
            await root.invalidateCacheForMutation(url);
            return result.data;
        } catch (error) {
            if (error.terminal) { const latest = read(); delete latest[slot]; write(latest); }
            else notice(error.message, record, owner);
            throw error;
        }
    }
    root.portalFileRequest = async function (url, options = {}) {
        const owner = identity();
        const scope = await accountScope(owner);
        const hash = await fingerprint(url, options);
        if (owner !== identity()) throw new Error('認証情報が変わりました。再読み込みしてください');
        const key = JSON.stringify([scope, options.method || 'POST', url]);
        // Double clicks share the same promise and never allocate a second ID.
        if (running.has(key)) {
            if (running.get(key).hash !== hash) throw new Error('保存中です。操作結果を確認してから変更してください');
            return running.get(key).promise;
        }
        const pending = perform(url, options, hash, owner, scope).finally(() => running.delete(key));
        running.set(key, { hash, promise: pending });
        return pending;
    };
    root.portalFileOperationsResume = async function () {
        const owner = identity();
        try {
            if (!root.portalRuntimeContext.appState?.portalAuthVerified) return;
            const ownerHash = await accountScope(owner);
            if (owner !== identity()) return;
            for (const record of Object.values(read())) {
                if (record.ownerHash === ownerHash) notice('前回の保存操作の結果を確認できます。', record, owner);
            }
        } catch (error) { console.warn('File operation status is unavailable:', error.message); }
    };
})(window);
