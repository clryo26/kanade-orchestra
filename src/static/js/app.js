// Deprecated compatibility entrypoint.
// Production entrypoint is main.js. This file only keeps backward compatibility
// for environments that still reference /static/js/app.js.
(function bootstrapLegacyAppJs(globalObj) {
    if (globalObj.__KANDE_PORTAL_APPJS_COMPAT_BOOTSTRAPPED__) {
        return;
    }
    globalObj.__KANDE_PORTAL_APPJS_COMPAT_BOOTSTRAPPED__ = true;

    const scriptPaths = [
        '/static/js/config.js',
        '/static/js/api.js',
        '/static/js/utils/api.js',
        '/static/js/utils/audio.js',
        '/static/js/utils/calendar.js',
        '/static/js/utils/cache.js',
        '/static/js/utils/dialog.js',
        '/static/js/store/app_state.js',
        '/static/js/utils/runtime_context.js',
        '/static/js/main.js',
        '/static/js/modules/common_helpers/pure.js',
        '/static/js/modules/common_helpers/ui.js',
        '/static/js/modules/common_helpers/api_runtime.js',
        '/static/js/modules/common_helpers/bootstrap_init.js',
        '/static/js/modules/common_helpers.js',
        '/static/js/modules/bootstrap_loader.js',
        '/static/js/modules/navigation/helpers.js',
        '/static/js/modules/navigation/tabs.js',
        '/static/js/modules/navigation/menu.js',
        '/static/js/modules/navigation/routes.js',
        '/static/js/modules/navigation/events.js',
        '/static/js/modules/navigation.js',
        '/static/js/modules/upload_forms.js',
        '/static/js/modules/admin_system/helpers.js',
        '/static/js/modules/admin_system/render.js',
        '/static/js/modules/admin_system/diagnostics.js',
        '/static/js/modules/admin_system.js',
        '/static/js/modules/portal_views.js',
        '/static/js/modules/performance_day/helpers.js',
        '/static/js/modules/performance_day/render.js',
        '/static/js/modules/practice_casting/helpers.js',
        '/static/js/modules/practice_casting/render.js',
        '/static/js/modules/practice_casting/events.js',
        '/static/js/modules/practice_casting.js',
        '/static/js/modules/date_piece_promotion/helpers.js',
        '/static/js/modules/date_piece_promotion/validation.js',
        '/static/js/modules/date_piece_promotion/events.js',
        '/static/js/modules/date_piece_promotion/state.js',
        '/static/js/modules/date_piece_promotion/api.js',
        '/static/js/modules/date_piece_promotion/render_piece_practice.js',
        '/static/js/modules/date_piece_promotion/render_desired_promotion.js',
        '/static/js/modules/date_piece_promotion/render.js',
        '/static/js/modules/date_piece_promotion.js',
        '/static/js/modules/announcements.js',
        '/static/js/modules/performances.js',
        '/static/js/modules/schedules.js',
        '/static/js/modules/recordings.js',
        '/static/js/recordings_feature.js',
        '/static/js/modules/members/helpers.js',
        '/static/js/modules/members/form.js',
        '/static/js/modules/members/api.js',
        '/static/js/modules/members/render.js',
        '/static/js/modules/members/events.js',
        '/static/js/modules/members.js',
        '/static/js/modules/absences.js',
        '/static/js/modules/payments.js',
        '/static/js/modules/events.js',
        '/static/js/modules/scores/helpers.js',
        '/static/js/modules/scores/render.js',
        '/static/js/modules/scores/events.js',
        '/static/js/modules/scores.js',
        '/static/js/modules/sns.js',
        '/static/js/auth_feature.js'
    ];

    function hasScript(path) {
        return Boolean(document.querySelector(`script[src*="${path}"]`));
    }

    function loadScriptSequentially(index) {
        if (index >= scriptPaths.length) {
            return;
        }

        const path = scriptPaths[index];
        if (hasScript(path)) {
            loadScriptSequentially(index + 1);
            return;
        }

        const script = document.createElement('script');
        script.src = path;
        script.async = false;
        script.onload = () => loadScriptSequentially(index + 1);
        script.onerror = () => {
            console.error(`[app.js compat] Failed to load ${path}`);
            loadScriptSequentially(index + 1);
        };
        document.head.appendChild(script);
    }

    loadScriptSequentially(0);
})(typeof window !== 'undefined' ? window : globalThis);
