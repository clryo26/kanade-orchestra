// Compatibility file only (production and the deprecated app.js loader still
// list it last). It must not define any sheet function: the implementations
// are the split files below, and a definition here would silently replace
// them because this file is loaded after them.
//   scores/sheet_api.js    network helper (no cached fallbacks)
//   scores/pdf_viewer.js   the PDF viewer (also used by reference scores)
//   scores/helpers.js      filters, sorting
//   scores/render.js       library and management lists
//   scores/sync.js         list version checks and updates
//   scores/save_dialog.js  saving a PDF / piece ZIP / concert ZIP
//   scores/upload_batch.js registering PDFs with operation IDs
//   scores/events.js       actions
