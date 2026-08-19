// Startup watchdog retry override.
// Keep startup_guard.js untouched because that legacy file has mixed EOL.
(function () {
    'use strict';

    if (window.__KANADE_STARTUP_RETRY_OVERRIDE_BOUND__) return;
    window.__KANADE_STARTUP_RETRY_OVERRIDE_BOUND__ = true;

    document.addEventListener('click', function (event) {
        var target = event.target && typeof event.target.closest === 'function'
            ? event.target.closest('#portalStartupRetryButton')
            : null;
        if (!target) return;

        var message = document.getElementById('portalStartupMessage');
        var watchdogMessage = '通信に時間がかかっています。再試行してください。';
        if (!message || String(message.textContent || '').trim() !== watchdogMessage) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        target.disabled = true;
        message.textContent = '再試行しています...';

        var retryUrl = new URL(window.location.href);
        retryUrl.searchParams.set('_portal_retry', String(Date.now()));
        window.location.replace(retryUrl.toString());
    }, true);
})();
