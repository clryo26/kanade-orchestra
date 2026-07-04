// UI/async helpers split from common_helpers.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;
let showAlertInProgress = false;

async function withButtonStatus(button, processingLabel, task) {
    if (!button || button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = processingLabel;
    try {
        return await task();
    } catch (error) {
        showAlert(error.message || '処理に失敗しました', 'danger');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function setOperationStatus(id, message, type = 'info') {
    const element = $(id);
    if (!element) return;
    element.hidden = false;
    element.className = `operation-status operation-status-${type}`;
    element.textContent = message;
}

function showAlert(message, type = 'info') {
    if (showAlertInProgress) {
        console.warn('showAlert re-entry suppressed:', message);
        return;
    }
    showAlertInProgress = true;
    try {
        const toastArea = $('toastArea');
        if (!toastArea) {
            console.warn('toastArea is missing:', message);
            return;
        }
        const toast = document.createElement('div');
        toast.className = `alert alert-${type} shadow-sm`;
        toast.textContent = String(message || '');
        toastArea.appendChild(toast);
        setTimeout(() => toast.remove(), 4200);
    } catch (error) {
        // Never throw from alert rendering to avoid recursive error cascades.
        console.error('showAlert failed:', error);
    } finally {
        showAlertInProgress = false;
    }
}

function setLoadingBar(label = '') {
    const bar = $('portalLoadingBar');
    const lbl = $('portalLoadingLabel');
    if (!bar) return;
    if (lbl) lbl.textContent = label;
    bar.hidden = false;
}

function clearLoadingBar() {
    const bar = $('portalLoadingBar');
    if (bar) bar.hidden = true;
}