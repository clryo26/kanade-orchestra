export function showConfirmDialog(message, onConfirm) {
    const ok = window.confirm(message);
    if (ok && typeof onConfirm === 'function') onConfirm();
    return ok;
}
