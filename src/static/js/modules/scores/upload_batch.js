// Registering several PDFs (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, sections 1 and 8).
//
// Each file has its own operation ID, fixed before it is sent. The batch
// (performance, piece, operation IDs, file name/size/date/SHA-256, finished
// and unfinished items) is kept in localStorage per account, so after a
// reload or a lost response the same IDs are sent again: a file the server
// already registered returns its first result instead of a second copy.
// Files themselves cannot be kept by the browser: after a reload the user
// selects them again and each one is checked against the stored fingerprint.
// Cancel stops the files not sent yet; registered sheets are never removed.
(function (root) {
    'use strict';

    var STORE_PREFIX = 'portalSheetUploadBatch:v1:';
    var MAX_FILES = 50;
    var MAX_PDF_BYTES = 30 * 1024 * 1024;
    var PROCESSING_RETRIES = 5;

    var api = function () { return root.portalSheetApi; };
    var state = function () { return window.portalRuntimeContext.appState; };
    var byId = function (id) {
        var ctx = window.portalRuntimeContext;
        return ctx && typeof ctx.getById === 'function' ? ctx.getById(id) : document.getElementById(id);
    };
    var running = null; // { batch, cancel }

    function storeKey() {
        return STORE_PREFIX + api().accountKey();
    }

    function load() {
        try {
            var batch = JSON.parse(window.localStorage.getItem(storeKey()) || 'null');
            return batch && Array.isArray(batch.items) ? batch : null;
        } catch (_) {
            return null;
        }
    }

    function save(batch) {
        try {
            if (batch) window.localStorage.setItem(storeKey(), JSON.stringify(batch));
            else window.localStorage.removeItem(storeKey());
        } catch (_) { /* private mode: the batch still runs, resume is not offered */ }
    }

    async function fingerprint(file) {
        if (!window.crypto || !window.crypto.subtle) return '';
        try {
            var digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
            return Array.prototype.map.call(new Uint8Array(digest), function (b) { return (b + 256).toString(16).slice(1); }).join('');
        } catch (_) {
            return '';
        }
    }

    function counts(batch) {
        var done = batch.items.filter(function (i) { return i.state === 'done'; }).length;
        return { done: done, total: batch.items.length, open: batch.items.length - done };
    }

    function status(text, tone) {
        if (typeof setOperationStatus === 'function') setOperationStatus('sheetUploadProgress', text, tone);
    }

    // Sends one file with its fixed operation ID. Returns 'done' | 'failed' | 'unknown'.
    async function sendOne(batch, item, file) {
        var form = new FormData();
        form.append('file', file);
        form.append('performance_id', batch.performanceId);
        form.append('performance_title', batch.performanceTitle);
        form.append('piece', batch.piece);
        for (var attempt = 0; attempt <= PROCESSING_RETRIES; attempt += 1) {
            var r;
            try {
                r = await api().call('/api/sheets/upload', { method: 'POST', body: form,
                    headers: { 'Idempotency-Key': item.operationId }, timeoutMs: 120000 });
            } catch (error) {
                // Sent but no answer: the server may have finished. Same ID later.
                item.error = error && error.kind === 'timeout' ? '応答がありませんでした' : '通信が途切れました';
                return 'unknown';
            }
            if (r.status === 200) {
                item.sheetId = r.data && r.data.file ? r.data.file.id : null;
                item.error = '';
                return 'done';
            }
            if (r.status === 202) {
                // Another attempt with this ID is still running: ask again.
                await new Promise(function (resolve) { setTimeout(resolve, 1500 * (attempt + 1)); });
                continue;
            }
            item.error = api().detailMessage(r.data, '登録できませんでした（' + r.status + '）');
            return r.status >= 500 ? 'unknown' : 'failed';
        }
        item.error = '処理中のまま応答がありません';
        return 'unknown';
    }

    async function run(batch, files) {
        if (running) return;
        running = { batch: batch, cancel: false };
        renderResume();
        try {
            var total = batch.items.length;
            for (var index = 0; index < batch.items.length; index += 1) {
                var item = batch.items[index];
                if (item.state === 'done' || item.state === 'failed') continue;
                if (running.cancel) break;
                var file = files[item.operationId];
                if (!file) continue;
                status('登録中: ' + item.name + '（' + (counts(batch).done + 1) + ' / ' + total + ' 件）');
                item.state = 'sending';
                save(batch);
                item.state = await sendOne(batch, item, file);
                save(batch);
                if (item.state === 'unknown') break; // keep the order; resume resends the same ID
            }
            var c = counts(batch);
            var failed = batch.items.filter(function (i) { return i.state === 'failed'; });
            var unknown = batch.items.filter(function (i) { return i.state === 'unknown' || i.state === 'pending' || i.state === 'sending'; });
            if (!unknown.length) {
                save(null);
                status((running.cancel ? '中止しました。' : '') + c.done + ' 件を登録しました' +
                    (failed.length ? '。登録できなかったファイル: ' + failed.map(function (i) { return i.name + '（' + i.error + '）'; }).join('、') : '。'),
                failed.length ? 'warning' : 'success');
            } else {
                status((running.cancel ? '中止しました。' : '途中で止まりました。') + '登録済み ' + c.done + ' / ' + c.total +
                    ' 件（登録済みの楽譜は残っています）。「続きを登録」で未完了の分から再開できます。', 'warning');
            }
            var input = byId('sheetFileInput');
            if (input) input.value = '';
            if (typeof refreshSheetLibrary === 'function') await refreshSheetLibrary({ force: true, reason: 'upload' });
        } finally {
            running = null;
            renderResume();
        }
    }

    async function uploadSheets() {
        if (running) return;
        var performanceId = (byId('sheetPerformanceSelect') || {}).value || '';
        var piece = (byId('sheetPieceSelect') || {}).value || '';
        var files = Array.from((byId('sheetFileInput') || {}).files || []);
        var performance = (state().performances || []).find(function (p) { return String(p.id) === String(performanceId); });
        if (!performanceId || !performance || !piece) { showAlert('演奏会と曲名を選択してください', 'warning'); return; }
        if (!files.length) { showAlert('PDFファイルを選択してください', 'warning'); return; }
        if (files.length > MAX_FILES) { showAlert('一度に登録できるのは' + MAX_FILES + '件までです', 'warning'); return; }
        if (files.some(function (f) { return !(f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf'); })) {
            showAlert('PDFファイルのみ登録できます', 'warning');
            return;
        }
        var large = files.filter(function (f) { return f.size > MAX_PDF_BYTES; });
        if (large.length) { showAlert('30MBを超えるPDFは登録できません: ' + large.map(function (f) { return f.name; }).join('、'), 'warning'); return; }
        var previous = load();
        if (previous && counts(previous).open && !window.confirm('前回の登録が途中です（未完了 ' + counts(previous).open + ' 件）。破棄して新しく登録しますか？（登録済みの楽譜は削除されません）')) return;
        status('ファイルを確認しています...');
        var batch = {
            batchId: api().newOperationId(), createdAt: new Date().toISOString(),
            performanceId: String(performanceId), performanceTitle: performance.title || '', piece: piece, items: [],
        };
        var byOperation = {};
        for (var i = 0; i < files.length; i += 1) {
            var f = files[i];
            var item = { operationId: api().newOperationId(), name: f.name, size: f.size, lastModified: f.lastModified,
                sha256: await fingerprint(f), state: 'pending', sheetId: null, error: '' };
            batch.items.push(item);
            byOperation[item.operationId] = f;
        }
        save(batch);
        await run(batch, byOperation);
    }

    function cancelUpload() {
        if (running) {
            running.cancel = true;
            status('中止しています。送信中のファイルが終わると止まります（登録済みの楽譜は残ります）...', 'warning');
        }
    }

    // After a reload: the user selects the files again; each is matched with
    // the stored name, size and fingerprint before its original ID is reused.
    async function resumeWith(fileList) {
        var batch = load();
        if (!batch || running) return;
        var open = batch.items.filter(function (i) { return i.state !== 'done' && i.state !== 'failed'; });
        var byOperation = {};
        var mismatched = [];
        var files = Array.from(fileList || []);
        for (var i = 0; i < open.length; i += 1) {
            var item = open[i];
            var candidate = files.find(function (f) { return f.name === item.name && f.size === item.size; });
            if (!candidate) continue;
            var sha = item.sha256 ? await fingerprint(candidate) : '';
            if (item.sha256 && sha && sha !== item.sha256) {
                mismatched.push(item.name);
                continue;
            }
            byOperation[item.operationId] = candidate;
        }
        var missing = open.filter(function (i) { return !byOperation[i.operationId]; }).map(function (i) { return i.name; });
        if (mismatched.length) showAlert('内容が前回と異なるため使えません: ' + mismatched.join('、'), 'warning');
        if (!Object.keys(byOperation).length) {
            status('未完了のファイルが選ばれていません: ' + missing.join('、'), 'warning');
            return;
        }
        if (missing.length) showAlert('次のファイルは選ばれていないため後回しにします: ' + missing.join('、'), 'info');
        await run(batch, byOperation);
    }

    function discard() {
        if (running) return;
        if (!window.confirm('途中の登録を破棄しますか？（登録済みの楽譜は削除されません）')) return;
        save(null);
        renderResume();
        status('途中の登録を破棄しました。', 'info');
    }

    function renderResume() {
        var host = byId('sheetUploadResume');
        if (!host) return;
        var cancel = byId('sheetUploadCancelBtn');
        if (cancel) cancel.hidden = !running;
        var batch = running ? null : load();
        if (!batch || !counts(batch).open) {
            host.innerHTML = '';
            host.hidden = true;
            return;
        }
        var c = counts(batch);
        var open = batch.items.filter(function (i) { return i.state !== 'done' && i.state !== 'failed'; });
        host.hidden = false;
        host.innerHTML = '<div class="alert alert-warning mb-3"><p class="mb-2"></p><ul class="small mb-2"></ul>' +
            '<label class="form-label small" for="sheetUploadResumeInput">未完了のファイルを選び直してください（内容を照合してから続きを登録します）</label>' +
            '<input type="file" class="form-control mb-2" id="sheetUploadResumeInput" accept="application/pdf,.pdf" multiple>' +
            '<div class="d-flex flex-wrap gap-2"><button class="btn btn-primary" type="button" id="sheetUploadResumeBtn">続きを登録</button>' +
            '<button class="btn btn-outline-secondary" type="button" id="sheetUploadDiscardBtn">破棄</button></div></div>';
        host.querySelector('p').textContent = '前回の登録が途中です（' + batch.piece + '・登録済み ' + c.done + ' / ' + c.total + ' 件）。';
        var list = host.querySelector('ul');
        open.forEach(function (i) {
            var li = document.createElement('li');
            li.textContent = i.name + (i.error ? '（' + i.error + '）' : '');
            list.appendChild(li);
        });
        var resumeButton = host.querySelector('#sheetUploadResumeBtn');
        var resumeInput = host.querySelector('#sheetUploadResumeInput');
        var discardButton = host.querySelector('#sheetUploadDiscardBtn');
        if (resumeButton) resumeButton.addEventListener('click', function (event) {
            withButtonStatus(event.currentTarget, '登録中...', function () { return resumeWith(resumeInput ? resumeInput.files : []); });
        });
        if (discardButton) discardButton.addEventListener('click', discard);
    }

    root.uploadSheets = uploadSheets;
    root.cancelSheetUpload = cancelUpload;
    root.renderSheetUploadResume = renderResume;
    root.portalSheetUpload = {
        busy: function () { return Boolean(running); },
        load: load,
        resumeWith: resumeWith,
        MAX_FILES: MAX_FILES,
        MAX_PDF_BYTES: MAX_PDF_BYTES,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
