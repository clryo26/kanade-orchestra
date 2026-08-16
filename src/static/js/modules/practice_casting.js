// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// 団員向け楽譜ビュー。
// 演奏会 -> 曲 -> ファイルの順で段階的に絞り込めるようにし、
// 大量の楽譜があっても目的のファイルへ辿り着きやすくしている。
// renderSheetLibraryView moved to feature module.

// showSheetViewer moved to feature module.

// clearSheetViewer moved to feature module.

async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-pdfjs]');
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.dataset.pdfjs = 'true';
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', reject, { once: true });
        document.head.appendChild(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return window.pdfjsLib;
}

async function renderPdfViewer(url, scale = null) {
    const pages = $('sheetViewerPages');
    const status = $('sheetViewerStatus');
    if (!pages || !status) return;
    appState.sheetPdfUrl = url;
    appState.sheetPdfRendering = true;
    pages.innerHTML = '';
    status.textContent = '楽譜を読み込み中...';
    try {
        const pdfjsLib = await loadPdfJs();
        const data = await fetchWithTimeout(url, { cache: 'no-store' }, PORTAL_TIMEOUT_GET).then((response) => {
            if (!response.ok) throw new Error(`PDFを取得できませんでした (${response.status})`);
            return response.arrayBuffer();
        });
        if (appState.sheetPdfUrl !== url) return;
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const firstPage = await pdf.getPage(1);
        appState.sheetPdfScale = scale || sheetViewerFitScale(firstPage);
        status.textContent = `${pdf.numPages}ページを表示中`;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (appState.sheetPdfUrl !== url) return;
            const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
            await renderPdfPage(page, pageNumber, appState.sheetPdfScale, pages);
        }
        status.textContent = `${pdf.numPages}ページ`;
    } catch (error) {
        status.textContent = 'PDFを表示できませんでした';
        showAlert(error.message || 'PDFを表示できませんでした', 'danger');
    } finally {
        appState.sheetPdfRendering = false;
    }
}

// sheetViewerFitScale moved to feature module.

async function renderPdfPage(page, pageNumber, scale, container) {
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement('section');
    wrapper.className = 'sheet-viewer-page';
    wrapper.innerHTML = `<div class="sheet-viewer-page-label">${pageNumber}</div>`;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    }).promise;
}

// zoomSheetViewer moved to feature module.

// fitSheetViewerWidth moved to feature module.

// sheetPieceOptions moved to feature module.

// sheetFilterPerformanceOptions moved to feature module.

// sheetFilterPieceOptions moved to feature module.

// sheetFilterPartOptions moved to feature module.

// sheetPartOptions moved to feature module.

// 支払管理画面。
// 団費と演奏会費の両方を 1 レコードに集約し、団員単位で入力・参照できる形にしている。
// function renderPaymentAdmin() moved to modules/payments.js.
