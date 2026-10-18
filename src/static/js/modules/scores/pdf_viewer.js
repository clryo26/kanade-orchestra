// The one PDF viewer of the portal (sheet library and desired-piece reference
// scores; docs/SHEET_LIBRARY_RELIABILITY_DESIGN.md, section 5).
//
// - PDF.js 4.10.38 (legacy build; CVE-2024-4367 fixed since 4.2.67, outside
//   the later >= 5.6.83 advisory) and its worker are served from this portal;
//   jsDelivr with the same version and build is only a fallback. A module of
//   another version is never used, and every document is opened with
//   isEvalSupported: false (the official workaround, kept as defence in
//   depth). Scripting (enableScripting / pdf.sandbox) is not loaded at all.
// - Every open / zoom / fit is one request with its own number. A newer request
//   aborts the older fetch and cancels its page renders, so an old PDF never
//   appears over a newer one.
// - Closing releases the document (and its worker), the render tasks and the
//   canvas memory.
// - Fetch failures, broken PDFs and render failures are told apart and can be
//   retried.
// Global names are kept (renderPdfViewer, zoomSheetViewer, ...) because the
// navigation handlers and the reference-score view call them.
(function (root) {
    'use strict';

    var PDFJS_VERSION = '4.10.38';
    var SOURCES = [
        '/static/vendor/pdfjs/' + PDFJS_VERSION + '/',
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/legacy/build/',
    ];
    // Options passed to every getDocument call (also with the fallback source).
    var SAFE_DOCUMENT_OPTIONS = Object.freeze({ isEvalSupported: false });
    var MIN_SCALE = 0.35;
    var MAX_SCALE = 3;
    var libraryPromise = null;
    var seq = 0;
    var current = null; // { seq, url, controller, task, pdf, renders:Set, scale }

    var state = function () { return window.portalRuntimeContext.appState; };
    var byId = function (id) {
        var ctx = window.portalRuntimeContext;
        return ctx && typeof ctx.getById === 'function' ? ctx.getById(id) : document.getElementById(id);
    };

    var loadedFrom = null;

    // PDF.js 4 is an ES module only. import() works in classic scripts; tests
    // (vm sandboxes cannot import) provide root.portalPdfViewerImport.
    function importModule(url) {
        if (typeof root.portalPdfViewerImport === 'function') return root.portalPdfViewerImport(url);
        return import(url);
    }

    function usable(lib) {
        return Boolean(lib && lib.version === PDFJS_VERSION && typeof lib.getDocument === 'function' && lib.GlobalWorkerOptions);
    }

    async function loadPdfJs() {
        // A test double without a version (E2E) is accepted; an old PDF.js of
        // another version left on the page is never used.
        var preset = window.pdfjsLib;
        if (preset && (preset.version === undefined || usable(preset))) return preset;
        if (!libraryPromise) {
            libraryPromise = (async function () {
                var lastError = null;
                for (var i = 0; i < SOURCES.length; i += 1) {
                    try {
                        var lib = await importModule(SOURCES[i] + 'pdf.min.mjs');
                        if (!usable(lib)) throw new Error('PDF.js of another version: ' + (lib && lib.version));
                        // The worker always comes from the same place and version.
                        lib.GlobalWorkerOptions.workerSrc = SOURCES[i] + 'pdf.worker.min.mjs';
                        loadedFrom = SOURCES[i];
                        return lib;
                    } catch (error) {
                        lastError = error;
                    }
                }
                throw lastError || new Error('PDF.js unavailable');
            })().catch(function (error) {
                libraryPromise = null; // a later attempt may succeed (network back)
                throw error;
            });
        }
        return libraryPromise;
    }

    function setStatus(text, retry) {
        var status = byId('sheetViewerStatus');
        if (!status) return;
        status.textContent = text;
        if (retry) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-sm btn-outline-primary ms-2';
            button.id = 'sheetViewerRetry';
            button.textContent = '再試行';
            button.addEventListener('click', retry);
            status.appendChild(button);
        }
    }

    function releaseCanvases(container) {
        if (!container) return;
        Array.prototype.forEach.call(container.querySelectorAll('canvas'), function (canvas) {
            // Width/height 0 lets Safari free the bitmap at once.
            canvas.width = 0;
            canvas.height = 0;
        });
        container.innerHTML = '';
    }

    function cancelRenders(entry) {
        if (!entry) return;
        entry.renders.forEach(function (task) {
            try { if (task && typeof task.cancel === 'function') task.cancel(); } catch (_) { /* finished */ }
        });
        entry.renders.clear();
    }

    function destroyDocument(entry) {
        if (!entry) return;
        try { if (entry.controller) entry.controller.abort(); } catch (_) { /* done */ }
        cancelRenders(entry);
        var pdf = entry.pdf;
        var task = entry.task;
        entry.pdf = null;
        entry.task = null;
        try {
            if (pdf && typeof pdf.destroy === 'function') pdf.destroy();
            else if (task && typeof task.destroy === 'function') task.destroy();
        } catch (_) { /* already destroyed */ }
    }

    function sheetViewerFitScale(page) {
        var body = byId('sheetViewerPages');
        var viewport = page.getViewport({ scale: 1 });
        var availableWidth = Math.max(((body && body.clientWidth) || window.innerWidth) - 24, 280);
        return Math.max(MIN_SCALE, Math.min(2.5, availableWidth / viewport.width));
    }

    function failure(kind, error) {
        if (kind === 'fetch') {
            var status = error && error.status;
            if (status === 404 || status === 410) return '楽譜が見つかりません。削除された可能性があります。一覧を更新してください。';
            if (status === 401) return 'ログインの状態を確認できません。ログインし直してください。';
            return 'PDFを取得できませんでした（通信）。通信状態を確認して再試行してください。';
        }
        if (kind === 'corrupt') return 'PDFファイルが壊れているか、読み取れない形式です。登録者に確認してください。';
        if (kind === 'library') return 'PDFを表示する部品を読み込めませんでした。再試行してください。';
        return 'PDFを描画できませんでした。再試行してください。';
    }

    async function fetchPdf(url, entry) {
        var api = root.portalSheetApi;
        var headers = {};
        var id = api ? api.deviceId() : '';
        if (id) headers['X-Device-Id'] = id;
        var response;
        try {
            response = await fetchWithTimeout(url, { headers: headers, cache: 'no-store', signal: entry.controller.signal },
                (typeof PORTAL_TIMEOUT_GET !== 'undefined' ? PORTAL_TIMEOUT_GET : 15000) || 15000);
        } catch (error) {
            throw Object.assign(new Error('fetch'), { stage: 'fetch', aborted: entry.controller.signal.aborted });
        }
        if (!response.ok) throw Object.assign(new Error('fetch'), { stage: 'fetch', status: response.status });
        try {
            return await response.arrayBuffer();
        } catch (_) {
            throw Object.assign(new Error('fetch'), { stage: 'fetch', aborted: entry.controller.signal.aborted });
        }
    }

    async function renderPdfPage(page, pageNumber, scale, container, entry) {
        var viewport = page.getViewport({ scale: scale });
        var wrapper = document.createElement('section');
        wrapper.className = 'sheet-viewer-page';
        wrapper.innerHTML = '<div class="sheet-viewer-page-label">' + pageNumber + '</div>';
        var canvas = document.createElement('canvas');
        var context = canvas.getContext('2d');
        var outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = Math.floor(viewport.width) + 'px';
        canvas.style.height = Math.floor(viewport.height) + 'px';
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);
        var task = page.render({
            canvasContext: context,
            viewport: viewport,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
        });
        if (entry) entry.renders.add(task);
        try {
            await task.promise;
        } finally {
            if (entry) entry.renders.delete(task);
        }
    }

    // "The API version ... does not match the Worker version ...": a library
    // problem (wrong or mixed files), not a broken PDF.
    function isLibraryError(error) {
        return Boolean(error && /does not match the Worker version|Setting up fake worker failed|Failed to fetch dynamically imported module/i.test(String(error.message || error)));
    }

    function isCancel(error) {
        return Boolean(error && (error.name === 'RenderingCancelledException' || error.aborted));
    }

    // url: the PDF; scale: null = fit to width. A zoom of the same document
    // re-renders it without fetching again.
    async function renderPdfViewer(url, scale) {
        var pages = byId('sheetViewerPages');
        if (!pages || !byId('sheetViewerStatus')) return;
        var mySeq = ++seq;
        var reuse = current && current.url === url && current.pdf ? current : null;
        if (reuse) {
            cancelRenders(reuse);
        } else {
            destroyDocument(current);
            current = { seq: mySeq, url: url, controller: new AbortController(), task: null, pdf: null, renders: new Set(), scale: null };
        }
        var entry = current;
        entry.seq = mySeq;
        var s = state();
        s.sheetPdfUrl = url;
        s.sheetPdfRendering = true;
        releaseCanvases(pages);
        var retry = function () { renderPdfViewer(url, scale == null ? null : scale); };
        setStatus(reuse ? '表示を更新しています...' : '楽譜を読み込み中...');
        var stage = 'library';
        try {
            var pdfjsLib = await loadPdfJs();
            if (entry.seq !== mySeq || current !== entry) return;
            if (!entry.pdf) {
                stage = 'fetch';
                var data = await fetchPdf(url, entry);
                if (entry.seq !== mySeq || current !== entry) return;
                stage = 'corrupt';
                entry.task = pdfjsLib.getDocument(Object.assign({ data: data }, SAFE_DOCUMENT_OPTIONS));
                entry.pdf = await entry.task.promise;
                if (entry.seq !== mySeq || current !== entry) return;
            }
            stage = 'render';
            var pdf = entry.pdf;
            var firstPage = await pdf.getPage(1);
            entry.scale = scale || sheetViewerFitScale(firstPage);
            s.sheetPdfScale = entry.scale;
            setStatus(pdf.numPages + 'ページを表示中');
            for (var pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                if (entry.seq !== mySeq || current !== entry) return;
                var page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
                if (entry.seq !== mySeq || current !== entry) return;
                await renderPdfPage(page, pageNumber, entry.scale, pages, entry);
            }
            if (entry.seq === mySeq && current === entry) setStatus(pdf.numPages + 'ページ');
        } catch (error) {
            if (entry.seq !== mySeq || current !== entry || isCancel(error)) return;
            var kind = error && error.stage ? error.stage : (isLibraryError(error) ? 'library' : stage);
            if (kind !== 'render') {
                // A document that could not be opened is not kept for zooming.
                destroyDocument(entry);
                current = null;
            }
            setStatus(failure(kind, error), retry);
        } finally {
            if (entry.seq === mySeq) s.sheetPdfRendering = false;
        }
    }

    function clearSheetViewer() {
        seq += 1;
        destroyDocument(current);
        current = null;
        var s = state();
        s.sheetPdfUrl = '';
        s.sheetPdfRendering = false;
        s.sheetViewerContext = null;
        releaseCanvases(byId('sheetViewerPages'));
        var status = byId('sheetViewerStatus');
        if (status) status.textContent = '';
    }

    function zoomSheetViewer(delta) {
        var s = state();
        if (!s.sheetPdfUrl || !current || !current.pdf) return Promise.resolve();
        var base = current.scale || s.sheetPdfScale || 1;
        var nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, base + delta));
        return renderPdfViewer(s.sheetPdfUrl, nextScale);
    }

    function fitSheetViewerWidth() {
        var s = state();
        if (!s.sheetPdfUrl) return Promise.resolve();
        return renderPdfViewer(s.sheetPdfUrl, null);
    }

    root.loadPdfJs = loadPdfJs;
    root.renderPdfViewer = renderPdfViewer;
    root.renderPdfPage = renderPdfPage;
    root.sheetViewerFitScale = sheetViewerFitScale;
    root.clearSheetViewer = clearSheetViewer;
    root.zoomSheetViewer = zoomSheetViewer;
    root.fitSheetViewerWidth = fitSheetViewerWidth;
    root.portalPdfViewer = {
        version: PDFJS_VERSION,
        sources: SOURCES.slice(),
        safeOptions: SAFE_DOCUMENT_OPTIONS,
        loadedFrom: function () { return loadedFrom; },
        current: function () { return current; },
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
