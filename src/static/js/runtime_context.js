// Deprecated compatibility entrypoint.
// Runtime shared globals are initialized in utils/runtime_context.js.
(function runtimeContextCompat(globalObj) {
    if (globalObj.portalRuntimeContext) {
        return;
    }

    if (typeof document === 'undefined') {
        return;
    }

    const existing = document.querySelector('script[src*="/static/js/utils/runtime_context.js"]');
    if (existing) {
        return;
    }

    const script = document.createElement('script');
    script.src = '/static/js/utils/runtime_context.js';
    script.async = false;
    document.head.appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);
