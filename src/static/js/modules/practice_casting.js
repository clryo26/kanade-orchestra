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

// loadPdfJs / renderPdfViewer / renderPdfPage moved to scores/pdf_viewer.js.
// They must not be defined here again: this file is also loaded by the
// casting screens after the viewer and would replace it.

// sheetViewerFitScale moved to feature module.

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
