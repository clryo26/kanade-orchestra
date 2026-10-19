// Saving a sheet PDF, a piece ZIP, a concert ZIP, a recording or a recording
// ZIP (docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, section 6).
//
// The way depends on the device (saveMode):
// - desktop (PC browser): the browser's own download, as before the dialog.
//   A single file starts downloading at once (no dialog). A ZIP shows a small
//   dialog with its progress and size, and the download starts by itself
//   when it is ready.
// - mobile (smartphone, tablet, home-screen app): one dialog, opened over the
//   current screen (the list, its filters and an open PDF stay as they are):
//   1. prepare: the file is fetched (single file) or the ZIP is built on the
//      server in steps (progress, 件数, cancel);
//   2. within the in-memory limit: when ready, the user presses 「保存先を選ぶ」; the OS
//      share/save sheet opens from that tap (sharing needs the user's gesture,
//      so it also works after a long preparation);
//   3. ZIP sharing unavailable, refused or over the limit: explain how to
//      open the portal directly in Safari. An in-app browser cannot be
//      assumed to save an attachment opened with target=_blank.
// The end of the share sheet is not a confirmation that the file was saved;
// the dialog says so.
(function (root) {
    'use strict';

    // In-memory limits (tuning values, design section 6.3). A file above them
    // is never read into the page; it goes through the ticket URL instead.
    var PDF_MEMORY_LIMIT = 30 * 1024 * 1024;
    var ZIP_MEMORY_LIMIT = 100 * 1024 * 1024;
    // Allow smaller limits for constrained devices and tests; never raise the
    // production ceiling through a runtime override.
    function memoryLimit(type) {
        var zip = type === 'application/zip';
        var ceiling = zip ? ZIP_MEMORY_LIMIT : PDF_MEMORY_LIMIT;
        var requested = Number((root.portalSheetSaveLimits || {})[zip ? 'zip' : 'pdf']);
        return requested > 0 && Number.isFinite(requested) ? Math.min(ceiling, requested) : ceiling;
    }
    var ZIP_POLL_MS = 1000;
    // Longer than the server's step claim (sheet_zip_service.STEP_LEASE, 240 s),
    // which is longer than the configured step allowance (MAX_STEP_SECONDS, 205 s).
    var ZIP_STEP_TIMEOUT_MS = 270000;
    var JOB_STORE_KEY = 'portalSheetZipJobs:v1';

    var api = function () { return root.portalSheetApi; };
    var state = function () { return window.portalRuntimeContext.appState; };

    var dialog = null; // { el, controller, opener, run, file, ticket, ... }

    function standalone() {
        return Boolean((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone);
    }

    // 'mobile' or 'desktop'. File sharing alone cannot tell them apart:
    // Chrome/Edge on Windows and Safari on macOS can share files too, and
    // there the browser's download is expected. iPads (also when they report
    // a Mac) and Android tablets count as mobile. portalSaveDeviceMode
    // overrides the detection (tests, support).
    function saveMode() {
        var forced = root.portalSaveDeviceMode;
        if (forced === 'mobile' || forced === 'desktop') return forced;
        if (standalone()) return 'mobile';
        var nav = window.navigator || {};
        if (nav.userAgentData && nav.userAgentData.mobile) return 'mobile';
        if (/iPhone|iPad|iPod|Android/i.test(String(nav.userAgent || ''))) return 'mobile';
        if (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1) return 'mobile';
        return 'desktop';
    }

    function desktop() {
        return saveMode() === 'desktop';
    }

    // The browser's own download, without leaving the portal: a same-origin
    // link with the download attribute is saved, never shown in this tab.
    // name '' keeps the server's file name (Content-Disposition).
    function browserDownload(url, name) {
        var link = document.createElement('a');
        link.href = url;
        link.download = name || '';
        link.rel = 'noopener';
        link.hidden = true;
        // Confirmed already (DL click or the ZIP dialog): skip the portal's
        // global "ダウンロードしますか？" (bootstrap_loader.js).
        if (link.dataset) link.dataset.downloadConfirm = 'off';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    function mediaTypeFor(name) {
        if (/\.pdf$/i.test(name)) return 'application/pdf';
        if (/\.mp3$/i.test(name)) return 'audio/mpeg';
        if (/\.(m4a|mp4|aac)$/i.test(name)) return 'audio/mp4';
        if (/\.wav$/i.test(name)) return 'audio/wav';
        return 'application/octet-stream';
    }

    // Asked per type: an iPhone may share PDFs but not ZIPs (or the reverse).
    function canShareType(type, name) {
        var nav = window.navigator;
        if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function' || typeof File !== 'function') return false;
        try {
            return Boolean(nav.canShare({ files: [new File([new Uint8Array([0x25])], name, { type: type })] }));
        } catch (_) {
            return false;
        }
    }

    function sizeText(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return '';
        if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function ensureDialog() {
        var el = document.getElementById('sheetSaveDialog');
        if (el) return el;
        document.body.insertAdjacentHTML('beforeend',
            '<div id="sheetSaveDialog" class="sheet-save-backdrop" hidden>' +
            '<div class="sheet-save-dialog" role="dialog" aria-modal="true" aria-labelledby="sheetSaveTitle">' +
            '<h2 class="h5" id="sheetSaveTitle">保存</h2>' +
            '<p class="mb-1 sheet-save-target" id="sheetSaveTarget"></p>' +
            '<p class="small text-muted mb-2" id="sheetSaveCount"></p>' +
            '<div class="progress mb-2" role="progressbar" aria-label="準備の進み具合" aria-valuemin="0" aria-valuemax="100" id="sheetSaveProgress">' +
            '<div class="progress-bar" style="width:0%"></div></div>' +
            '<p class="mb-2" id="sheetSaveStatus" role="status" aria-live="polite"></p>' +
            '<ul class="small mb-2" id="sheetSaveMissing" hidden></ul>' +
            '<div id="sheetSaveBrowserGuide" hidden class="alert alert-info small sheet-save-actions">' +
            '<p>iPhone・iPadでは、Safariアプリでこのポータルを直接開き、同じ一括DLを選んでください。ホーム画面アプリやアプリ内ブラウザーでは保存できない場合があります。</p>' +
            '<p>Safariで直接開いている場合は、下の「ダウンロード」を押してください。</p>' +
            '<label for="sheetSavePortalUrl">Safariで開くポータルのURL</label>' +
            '<input id="sheetSavePortalUrl" class="form-control mb-2" type="text" readonly>' +
            '<button id="sheetSaveCopyUrl" class="btn btn-sm btn-outline-primary" type="button">URLをコピー</button>' +
            '<p id="sheetSaveCopyStatus" class="mb-0" role="status"></p></div>' +
            '<div class="d-flex flex-wrap gap-2 sheet-save-actions">' +
            '<button class="btn btn-primary" type="button" id="sheetSaveShare" hidden>保存先を選ぶ</button>' +
            '<button class="btn btn-primary" type="button" id="sheetSaveOpen" hidden>別の画面で開いて保存</button>' +
            '<button class="btn btn-outline-primary" type="button" id="sheetSavePartial" hidden>不足分を除いてZIPを作成</button>' +
            '<button class="btn btn-outline-primary" type="button" id="sheetSaveRetry" hidden>再試行</button>' +
            '<button class="btn btn-outline-secondary" type="button" id="sheetSaveCancel">キャンセル</button>' +
            '<button class="btn btn-outline-secondary" type="button" id="sheetSaveClose" hidden>閉じる</button>' +
            '</div></div></div>');
        el = document.getElementById('sheetSaveDialog');
        el.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                cancelOrClose();
            }
        });
        document.getElementById('sheetSaveCancel').addEventListener('click', cancelOrClose);
        document.getElementById('sheetSaveClose').addEventListener('click', closeDialog);
        document.getElementById('sheetSaveShare').addEventListener('click', shareNow);
        document.getElementById('sheetSaveOpen').addEventListener('click', openTicket);
        document.getElementById('sheetSaveCopyUrl').addEventListener('click', copyPortalUrl);
        document.getElementById('sheetSaveRetry').addEventListener('click', function () { if (dialog) start(dialog.target, dialog.opener); });
        document.getElementById('sheetSavePartial').addEventListener('click', partialZip);
        return el;
    }

    function ui(patch) {
        var get = function (id) { return document.getElementById(id); };
        if ('browserGuide' in patch) get('sheetSaveBrowserGuide').hidden = !patch.browserGuide;
        if ('status' in patch) get('sheetSaveStatus').textContent = patch.status;
        if ('progress' in patch) {
            var bar = get('sheetSaveProgress');
            var pct = patch.progress == null ? 0 : Math.max(0, Math.min(100, Math.round(patch.progress)));
            bar.hidden = patch.progress == null;
            bar.setAttribute('aria-valuenow', String(pct));
            bar.firstChild.style.width = pct + '%';
        }
        ['share', 'open', 'partial', 'retry', 'cancel', 'close'].forEach(function (key) {
            if (key in patch) get('sheetSave' + key.charAt(0).toUpperCase() + key.slice(1)).hidden = !patch[key];
        });
        if ('missing' in patch) {
            var list = get('sheetSaveMissing');
            list.innerHTML = '';
            (patch.missing || []).forEach(function (m) {
                var li = document.createElement('li');
                li.textContent = m.label || ('楽譜 ' + m.sheet_id);
                list.appendChild(li);
            });
            list.hidden = !(patch.missing && patch.missing.length);
        }
    }

    function focusFirst() {
        var el = document.getElementById('sheetSaveDialog');
        var button = Array.prototype.find.call(el.querySelectorAll('button'), function (b) {
            return !b.hidden && !(b.closest && b.closest('[hidden]'));
        });
        if (button) button.focus();
    }

    // target: { kind: 'file', sheet } | { kind: 'zip', performanceId, piece, part, title, count }
    //         | { kind: 'url', url, name, media?: 'audio', size? }   (reference score, recording)
    //         | { kind: 'recording-zip', url, infoUrl, title }
    function openSheetSave(target, opener) {
        if (desktop() && (target.kind === 'file' || target.kind === 'url')) {
            desktopFileDownload(target, opener);
            return;
        }
        var el = ensureDialog();
        if (dialog && dialog.controller) dialog.controller.abort();
        el.hidden = false;
        document.body.classList.add('sheet-save-open');
        start(target, opener || document.activeElement);
    }

    // extra: ZIP options chosen explicitly by the user (partial ZIP).
    function start(target, opener, extra) {
        if (dialog && dialog.controller) dialog.controller.abort();
        dialog = { target: target, opener: opener, controller: new AbortController(), file: null, ticket: null, jobId: null,
            account: api().accountKey(), closed: false };
        var title = document.getElementById('sheetSaveTitle');
        var label = document.getElementById('sheetSaveTarget');
        var count = document.getElementById('sheetSaveCount');
        var size = target.kind === 'file' ? Number(target.sheet.size || 0) : Number(target.size || 0);
        if (target.kind === 'zip') {
            title.textContent = target.piece ? '曲のZIPを保存' : '演奏会のZIPを保存';
            label.textContent = [target.title, target.piece, target.part].filter(Boolean).join(' / ');
            count.textContent = target.count ? target.count + ' 件の楽譜' : '';
        } else if (target.kind === 'recording-zip') {
            title.textContent = '録音のZIPを保存';
            label.textContent = target.title || '録音';
            count.textContent = '大きさを確認しています...';
        } else {
            title.textContent = target.media === 'audio' ? '録音を保存' : 'PDFを保存';
            label.textContent = target.kind === 'file' ? (target.sheet.name || '楽譜') : (target.name || 'PDF');
            count.textContent = size ? '1 件・' + sizeText(size) : '1 件';
        }
        // On a PC the file goes to the browser's downloads (no other screen).
        document.getElementById('sheetSaveOpen').textContent = desktop() ? 'ダウンロード' : '別の画面で開いて保存';
        ui({ status: '準備しています...', progress: 0, share: false, open: false, partial: false, retry: false, cancel: true, close: false, missing: [], browserGuide: false });
        document.getElementById('sheetSaveCopyStatus').textContent = '';
        focusFirst();
        var d = dialog;
        var run = target.kind === 'zip' ? prepareZip(d, extra)
            : target.kind === 'recording-zip' ? prepareRecordingZip(d) : prepareFile(d);
        d.run = run;
        run.catch(function (error) { fail(d, error); });
    }

    function current(d) {
        return dialog === d && !d.closed && api().accountKey() === d.account;
    }

    function fail(d, error) {
        if (!current(d)) return;
        if (error && error.kind === 'aborted') return;
        var message = error && error.message ? error.message : '準備できませんでした。';
        if (error && error.kind === 'network') message = '通信できませんでした。通信状態を確認して再試行してください。';
        if (error && error.kind === 'timeout') message = '通信がタイムアウトしました。再試行してください。';
        if (error && error.kind === 'account') message = 'ログインの状態が変わったため中止しました。';
        ui({ status: message, progress: null, share: false, open: false, retry: true, cancel: false, close: true });
        focusFirst();
    }

    async function readBlob(d, url, total, type, name) {
        // Keep cancellation and the timeout alive through body consumption:
        // fetchWithTimeout only owns the request until headers arrive. This
        // controller is separate so a size rejection can still issue a ticket.
        var transfer = new AbortController();
        var reader = null;
        var chunks = [];
        var timedOut = false;
        function stop() {
            transfer.abort();
            if (reader) Promise.resolve(reader.cancel()).catch(function () {});
        }
        d.controller.signal.addEventListener('abort', stop, { once: true });
        var timer = setTimeout(function () { timedOut = true; stop(); }, 120000);
        try {
            if (d.controller.signal.aborted) stop();
            var r = await api().call(url, { signal: transfer.signal, raw: true, timeoutMs: 120000 });
            if (r.status !== 200) {
                var err = await r.response.json().catch(function () { return null; });
                throw api().SheetApiError(r.status === 404 || r.status === 410 ? 'ファイルが見つかりません。一覧を更新してください。'
                    : api().detailMessage(err, 'ファイルを取得できませんでした（' + r.status + '）'), { kind: 'http', status: r.status });
            }
            // Fetch exposes decoded bytes; a compressed wire Content-Length
            // cannot validate their length. `total` must be exact or zero.
            var length = (r.headers.get('content-encoding') ? 0 : Number(r.headers.get('content-length'))) || total || 0;
            var received = 0;
            reader = r.response.body.getReader();
            var limit = memoryLimit(type);
            if (length > limit || total > limit) {
                throw api().SheetApiError('ファイルが大きすぎるため、別の画面で保存してください。', { kind: 'too-large' });
            }
            for (;;) {
                var step = await reader.read();
                if (transfer.signal.aborted || !current(d)) throw api().SheetApiError('中止しました', { kind: 'aborted' });
                if (step.done) break;
                var nextSize = received + step.value.byteLength;
                // Inspect actual bytes before retaining another chunk, even
                // when the server omits or misreports Content-Length.
                if (nextSize > limit) {
                    throw api().SheetApiError('ファイルが大きすぎるため、別の画面で保存してください。', { kind: 'too-large' });
                }
                if (length && nextSize > length) throw api().SheetApiError('ファイルの大きさが一致しません。再試行してください。', { kind: 'size' });
                chunks.push(step.value);
                received = nextSize;
                if (current(d) && length) ui({ status: '取得しています... ' + sizeText(received) + ' / ' + sizeText(length), progress: 100 * received / length });
            }
            if (length && received !== length) throw api().SheetApiError('ファイルを最後まで受け取れませんでした。再試行してください。', { kind: 'network' });
            // Keep the server's ZIP name (piece/part/partial markers), as a
            // browser download does. Never treat it as a path on the device.
            if (type === 'application/zip') name = zipFilename(r.headers, name);
            return new File(chunks, name, { type: type });
        } catch (error) {
            if (timedOut) throw api().SheetApiError('通信がタイムアウトしました', { kind: 'timeout' });
            if (d.controller.signal.aborted) throw api().SheetApiError('中止しました', { kind: 'aborted' });
            if (error && error.kind) throw error;
            throw api().SheetApiError('通信が途中で切れました。再試行してください。', { kind: 'network' });
        } finally {
            clearTimeout(timer);
            d.controller.signal.removeEventListener('abort', stop);
            stop();
            if (reader && typeof reader.releaseLock === 'function') reader.releaseLock();
            chunks.length = 0;
        }
    }

    async function prepareFile(d) {
        var t = d.target;
        var audio = t.media === 'audio';
        var name = t.kind === 'file' ? (t.sheet.name || 'score.pdf') : (t.name || (audio ? 'recording.mp3' : 'score.pdf'));
        if (!audio && !/\.pdf$/i.test(name)) name += '.pdf';
        var type = mediaTypeFor(name);
        var size = t.kind === 'file' ? Number(t.sheet.size || 0) : Number(t.size || 0);
        var url = t.kind === 'file' ? (t.sheet.download_url || t.sheet.url) : t.url;
        // Recordings use the single-file limit; a larger one is never read
        // into the page, it goes straight to the separate screen.
        if (canShareType(type, 'check' + (name.match(/\.[^.]+$/) || ['.pdf'])[0]) && (!size || size <= memoryLimit(type))) {
            try {
                d.file = await readBlob(d, url, size, type, name);
            } catch (error) {
                if (!error || error.kind !== 'too-large') throw error;
            }
            if (!current(d)) return;
            if (d.file) {
                ui({ status: '準備ができました。「保存先を選ぶ」を押して、保存先（「ファイル」に保存など）を選んでください。', progress: 100, share: true, cancel: false, close: true });
                focusFirst();
                return;
            }
        }
        await prepareTicket(d, t.kind === 'file' ? { kind: 'file', id: t.sheet.id } : null, url);
    }

    // Ticket URLs are opened by navigation, which cannot send X-Device-Id;
    // the short-lived ticket stands in for it. Recordings need no ticket
    // (directUrl). lead: the size line shown before the user starts.
    async function prepareTicket(d, ticketTarget, directUrl, lead) {
        if (ticketTarget) {
            var r = await api().call('/api/sheets/tickets', { method: 'POST', json: ticketTarget, signal: d.controller.signal });
            if (r.status !== 200) throw api().SheetApiError(api().detailMessage(r.data, '保存用のリンクを用意できませんでした'), { kind: 'http', status: r.status });
            d.ticket = { url: r.data.url, expiresAt: Date.parse(r.data.expires_at) || 0, target: ticketTarget };
        } else {
            d.ticket = { url: directUrl, expiresAt: 0, target: null };
        }
        if (!current(d)) return;
        var prefix = lead ? lead + ' ' : '';
        if (desktop()) {
            // A PC downloads at once (agreed: no second tap after a ZIP was
            // built); the button stays for downloading again.
            browserDownload(d.ticket.url, '');
            ui({ status: prefix + 'ダウンロードを開始しました。ブラウザーのダウンロード一覧を確認してください。始まらない場合は「ダウンロード」を押してください。',
                progress: 100, open: true, cancel: false, close: true });
            focusFirst();
            return;
        }
        if (zipTarget(d.target)) {
            // There is no reliable web API to force the full Safari app.
            // Copy only the public portal URL, never its bearer ticket.
            document.getElementById('sheetSavePortalUrl').value = window.location.origin + '/';
            document.getElementById('sheetSaveOpen').textContent = 'ダウンロード';
            ui({ status: prefix + 'このZIPは共有画面で保存できません。Safariでの保存方法を確認してください。',
                progress: 100, share: false, open: true, browserGuide: true, cancel: false, close: true });
            focusFirst();
            return;
        }
        ui({ status: prefix + (standalone()
            ? '「別の画面で開いて保存」を押すと、ポータルを開いたまま別の画面でファイルを開きます。そこで共有ボタンから保存先を選び、終わったら「完了」でポータルに戻ってください。'
            : '「別の画面で開いて保存」を押すと、ダウンロードが始まります。'),
        progress: 100, open: true, cancel: false, close: true });
        focusFirst();
    }

    // PC, single file: the browser's download straight away, no dialog,
    // after the same "ダウンロードしますか？" as the DL links before the dialog.
    // A sheet needs a ticket first (its route requires the device header).
    async function desktopFileDownload(target, opener) {
        if (typeof root.confirm === 'function' && !root.confirm('ダウンロードしますか？')) return;
        if (target.kind !== 'file') {
            browserDownload(target.url, target.name || '');
            return;
        }
        if (opener && opener.dataset) {
            if (opener.dataset.saveBusy === '1') return; // double click
            opener.dataset.saveBusy = '1';
        }
        try {
            var r = await api().call('/api/sheets/tickets', { method: 'POST', json: { kind: 'file', id: target.sheet.id } });
            if (r.status !== 200) throw api().SheetApiError(api().detailMessage(r.data, 'ダウンロードを開始できませんでした'), { kind: 'http', status: r.status });
            browserDownload(r.data.url, '');
        } catch (error) {
            if (error && error.kind === 'account') return;
            var message = error && error.kind === 'network' ? '通信できませんでした。通信状態を確認して、もう一度「DL」を押してください。'
                : error && error.kind === 'timeout' ? '通信がタイムアウトしました。もう一度「DL」を押してください。'
                    : (error && error.message) || 'ダウンロードを開始できませんでした。';
            if (typeof root.showAlert === 'function') root.showAlert(message, 'danger');
        } finally {
            if (opener && opener.dataset) delete opener.dataset.saveBusy;
        }
    }

    async function shareNow() {
        var d = dialog;
        if (!d || !current(d) || !d.file) return;
        try {
            // Runs inside this tap (the OS requires a user gesture).
            await window.navigator.share({ files: [d.file], title: d.file.name });
            if (current(d)) ui({ status: '共有画面を閉じました。保存できたかは、保存先（「ファイル」アプリなど）で確認してください。', share: true, close: true });
        } catch (error) {
            if (!current(d)) return;
            if (error && error.name === 'AbortError') {
                ui({ status: '保存先の選択をやめました。もう一度「保存先を選ぶ」を押せます。', share: true, close: true });
            } else {
                // Sharing refused (e.g. NotAllowedError): offer the other way.
                d.file = null;
                ui({ status: '共有画面を開けませんでした。別の方法で保存します...', share: false });
                var target = d.target.kind === 'file' ? { kind: 'file', id: d.target.sheet.id }
                    : d.target.kind === 'zip' ? { kind: 'zip', id: d.jobId } : null;
                prepareTicket(d, target, d.target.url).catch(function (e) { fail(d, e); });
            }
        }
    }

    async function openTicket() {
        var d = dialog;
        if (!d || !current(d) || !d.ticket || d.renewing) return;
        if (d.ticket.target && d.ticket.expiresAt && Date.now() > d.ticket.expiresAt - 30000) {
            // Renewal may outlive transient user activation. Only renew on
            // this tap; opening requires the next explicit tap after it ends.
            d.renewing = true;
            ui({ status: '保存用のリンクを更新しています...', open: false });
            try {
                var r = await api().call('/api/sheets/tickets', { method: 'POST', json: d.ticket.target, signal: d.controller.signal });
                if (!current(d)) return;
                if (r.status !== 200) throw new Error(api().detailMessage(r.data, '保存用のリンクを用意できませんでした'));
                d.ticket.url = r.data.url;
                d.ticket.expiresAt = Date.parse(r.data.expires_at) || 0;
                ui({ status: '準備ができました。もう一度「' + document.getElementById('sheetSaveOpen').textContent + '」を押してください。', open: true, close: true });
            } catch (error) {
                fail(d, error);
            } finally {
                d.renewing = false;
            }
            return;
        }
        if (desktop() || zipTarget(d.target)) {
            browserDownload(d.ticket.url, '');
            if (current(d)) ui({ status: 'ダウンロードを開始しました。ブラウザーのダウンロード一覧を確認してください。', open: true, close: true });
            return;
        }
        // Mobile: always a separate browsing context (never this page), so an
        // iPhone home-screen app shows it in its in-app browser.
        var link = document.createElement('a');
        link.href = d.ticket.url;
        link.target = '_blank';
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (current(d)) ui({ status: standalone()
            ? '別の画面が表示されたら共有ボタンから保存してください。保存後は「完了」でポータルに戻れます。表示されない場合は、もう一度ボタンを押してください。保存できたかは保存先で確認してください。'
            : '別の画面やダウンロード先を確認してください。表示されない場合は、もう一度ボタンを押してください。保存できたかは保存先で確認してください。', open: true, close: true });
    }

    // ----- ZIP ---------------------------------------------------------------------

    function scopeKey(t) {
        return [api().accountKey(), t.performanceId, t.scope || '', t.piece || '', t.part || ''].join('|');
    }

    function readJobs() {
        try { return JSON.parse(window.localStorage.getItem(JOB_STORE_KEY) || '{}') || {}; } catch (_) { return {}; }
    }

    function rememberJob(t, jobId) {
        try {
            var jobs = readJobs();
            var now = Date.now();
            Object.keys(jobs).forEach(function (k) { if (now - (jobs[k].savedAt || 0) > 24 * 3600 * 1000) delete jobs[k]; });
            if (jobId) jobs[scopeKey(t)] = { jobId: jobId, savedAt: now };
            else delete jobs[scopeKey(t)];
            window.localStorage.setItem(JOB_STORE_KEY, JSON.stringify(jobs));
        } catch (_) { /* best effort: the server keeps the job anyway */ }
    }

    async function zipCall(d, path, method, json) {
        var r = await api().call(path, { method: method || 'GET', json: json, signal: d.controller.signal,
            timeoutMs: /\/step$/.test(path) ? ZIP_STEP_TIMEOUT_MS : 60000 });
        if (r.status !== 200) throw api().SheetApiError(api().detailMessage(r.data, 'ZIPを準備できませんでした（' + r.status + '）'), { kind: 'http', status: r.status });
        return r.data;
    }

    function showJob(d, job) {
        if (!current(d)) return;
        var pct = job.file_count ? 100 * job.done_count / job.file_count : 0;
        document.getElementById('sheetSaveCount').textContent = job.file_count + ' 件の楽譜' + (job.total_bytes ? '（約 ' + sizeText(job.total_bytes) + '）' : '');
        ui({ status: 'ZIPを作成しています... ' + job.done_count + ' / ' + job.file_count + ' 件', progress: pct });
    }

    async function prepareZip(d, extra) {
        var t = d.target;
        var job = null;
        var known = !extra && readJobs()[scopeKey(t)];
        if (known) {
            try {
                job = await zipCall(d, '/api/sheets/zip-jobs/' + encodeURIComponent(known.jobId));
                // A finished ZIP of an older list, or a failed one, is not reused.
                if (job.changed_since || ['failed', 'cancelled', 'expired', 'incomplete'].indexOf(job.state) >= 0) job = null;
            } catch (error) {
                if (error && error.kind === 'aborted') throw error;
                job = null;
            }
        }
        if (!job) {
            job = await zipCall(d, '/api/sheets/zip-jobs', 'POST', Object.assign({
                performance_id: String(t.performanceId), piece: t.piece || '', part: t.part || '',
                scope: t.scope || (t.piece ? 'piece' : 'performance'),
            }, extra || {}));
        }
        d.jobId = job.job_id;
        rememberJob(t, job.job_id);
        while (job.state === 'building') {
            showJob(d, job);
            if (d.controller.signal.aborted) throw api().SheetApiError('中止しました', { kind: 'aborted' });
            job = await zipCall(d, '/api/sheets/zip-jobs/' + encodeURIComponent(job.job_id) + '/step', 'POST', {});
            if (job.state === 'building' && job.busy) {
                // Another step of this job really is running (e.g. another
                // tab, or a request whose answer was lost): wait, never run twice.
                await new Promise(function (resolve) { setTimeout(resolve, ZIP_POLL_MS); });
            }
        }
        if (!current(d)) return;
        if (job.state === 'incomplete') {
            rememberJob(t, null);
            d.missing = job.missing || [];
            ui({ status: '取得できない楽譜があるため、すべてを含むZIPは作成できませんでした。足りない楽譜を除いて作成するか、閉じて一覧を確認してください。',
                progress: null, missing: d.missing, partial: true, retry: true, cancel: false, close: true });
            focusFirst();
            return;
        }
        if (job.state !== 'ready') {
            rememberJob(t, null);
            throw api().SheetApiError(job.state === 'failed' && job.error_code === 'too_large'
                ? '合計が大きすぎるためZIPを作成できませんでした。曲やパートで絞り込んでください。'
                : 'ZIPを作成できませんでした。再試行してください。', { kind: 'job', state: job.state });
        }
        d.zipReady = true; // cancelling the receive must not cancel a completed server ZIP
        var partialNote = job.allow_partial && job.missing && job.missing.length ? '（不足している楽譜は含まれていません。ZIP内の一覧を確認してください）' : '';
        var bytes = Number(job.zip_bytes || 0);
        if (bytes) {
            document.getElementById('sheetSaveCount').textContent = job.file_count + ' 件の楽譜・ZIP ' + sizeText(bytes);
        }
        var lead = 'ZIPの準備ができました' + (bytes ? '（' + sizeText(bytes) + '）' : '') + partialNote + '。';
        var name = (job.title || t.title || '楽譜') + (partialNote ? '_一部' : '') + '.zip';
        await prepareZipSave(d, '/api/sheets/zip-jobs/' + encodeURIComponent(job.job_id) + '/download',
            bytes, bytes, name, { kind: 'zip', id: job.job_id }, lead);
        if (partialNote && current(d)) ui({ missing: job.missing });
    }

    // A recording ZIP's source total excludes ZIP headers, so it is only
    // an estimate. Enforce the memory ceiling on the actual received bytes.
    async function prepareRecordingZip(d) {
        var t = d.target;
        var r = await api().call(t.infoUrl, { signal: d.controller.signal });
        if (r.status !== 200 || !r.data) {
            throw api().SheetApiError(r.status === 404 ? '保存できる録音がありません。一覧を更新してください。'
                : api().detailMessage(r.data, '録音のZIPを準備できませんでした（' + r.status + '）'), { kind: 'http', status: r.status });
        }
        if (!current(d)) return;
        var info = r.data;
        var bytes = Number(info.total_bytes || 0);
        var missing = Number(info.missing_count || 0);
        document.getElementById('sheetSaveCount').textContent = info.file_count + ' 件の録音・ZIP 約 ' + sizeText(bytes);
        var lead = '録音のZIPは約 ' + sizeText(bytes) + ' です' +
            (missing ? '（取得できない録音 ' + missing + ' 件は含まれません）' : '') + '。';
        await prepareZipSave(d, t.url, bytes, 0, (t.title || '録音') + '.zip', null, lead);
    }

    function zipTarget(target) {
        return target.kind === 'zip' || target.kind === 'recording-zip';
    }

    function zipFilename(headers, fallback) {
        var disposition = headers.get('content-disposition') || '';
        var encoded = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(disposition);
        var plain = /filename\s*=\s*"([^"\r\n]+)"/i.exec(disposition);
        var name = fallback;
        if (encoded) {
            try { name = decodeURIComponent(encoded[1]); } catch (_) { /* use the safe fallback */ }
        } else if (plain) name = plain[1];
        return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    }

    async function copyPortalUrl() {
        var d = dialog;
        if (!d || !current(d)) return;
        var input = document.getElementById('sheetSavePortalUrl');
        try {
            await window.navigator.clipboard.writeText(input.value);
            if (current(d)) document.getElementById('sheetSaveCopyStatus').textContent = 'URLをコピーしました。Safariのアドレス欄に貼り付けて開いてください。';
        } catch (_) {
            if (!current(d)) return;
            input.focus();
            input.select();
            document.getElementById('sheetSaveCopyStatus').textContent = 'URLを長押ししてコピーし、Safariで開いてください。';
        }
    }

    async function prepareZipSave(d, url, estimate, exactSize, name, ticketTarget, lead) {
        var type = 'application/zip';
        // Only mobile needs a buffered File. A tap after preparation invokes
        // share(); neither the ZIP fetch nor sharing navigates the portal.
        if (!desktop() && estimate <= memoryLimit(type) && canShareType(type, 'check.zip')) {
            try {
                var file = await readBlob(d, url, exactSize, type, name.replace(/[\\/:*?"<>|]/g, '_'));
                if (!current(d)) return;
                var shareable = false;
                try { shareable = window.navigator.canShare({ files: [file] }); } catch (_) { /* fall back to Safari guidance */ }
                if (shareable) {
                    d.file = file;
                    ui({ status: lead + '「保存先を選ぶ」を押して、共有画面の「ファイルに保存」から保存してください。',
                        progress: 100, share: true, open: false, browserGuide: false, cancel: false, close: true });
                    focusFirst();
                    return;
                }
            } catch (error) {
                if (!error || error.kind !== 'too-large') throw error;
            }
        }
        if (!current(d)) return;
        await prepareTicket(d, ticketTarget, ticketTarget ? null : url, lead);
    }

    function partialZip() {
        var d = dialog;
        if (!d || d.target.kind !== 'zip') return;
        var missing = d.missing || [];
        // The user chose it explicitly: a ZIP without the missing sheets.
        start(d.target, d.opener, { allow_partial: true, exclude_sheet_ids: missing.map(function (m) { return m.sheet_id; }), missing: missing });
    }

    function cancelOrClose() {
        var d = dialog;
        if (!d) return;
        var busy = !document.getElementById('sheetSaveCancel').hidden;
        if (busy && d.jobId && d.target.kind === 'zip' && !d.zipReady) {
            // Stop building on the server too; finished sheets stay as they are.
            api().call('/api/sheets/zip-jobs/' + encodeURIComponent(d.jobId) + '/cancel', { method: 'POST', json: {} }).catch(function () {});
            rememberJob(d.target, null);
        }
        closeDialog();
    }

    function closeDialog() {
        var d = dialog;
        if (d) {
            d.closed = true;
            if (d.controller) d.controller.abort();
            d.file = null; // free the memory of a prepared file
        }
        dialog = null;
        var el = document.getElementById('sheetSaveDialog');
        if (el) el.hidden = true;
        document.body.classList.remove('sheet-save-open');
        if (d && d.opener && typeof d.opener.focus === 'function' && document.contains(d.opener)) d.opener.focus();
    }

    function saveBusy() {
        return Boolean(dialog && !document.getElementById('sheetSaveCancel').hidden);
    }

    root.openSheetSave = openSheetSave;
    root.closeSheetSave = closeDialog;
    root.portalSheetSave = {
        PDF_MEMORY_LIMIT: PDF_MEMORY_LIMIT,
        ZIP_MEMORY_LIMIT: ZIP_MEMORY_LIMIT,
        limit: memoryLimit,
        canShareType: canShareType,
        mode: saveMode,
        busy: saveBusy,
        current: function () { return dialog; },
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
