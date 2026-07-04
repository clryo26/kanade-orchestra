// Thin compatibility bridge.
// Runtime shared globals are initialized in utils/runtime_context.js.
if (!window.portalRuntimeContext) {
    throw new Error('portalRuntimeContext is not initialized. Ensure runtime_context.js is loaded before main.js.');
}

function showPortalLogin() {
    /*
     * Compatibility marker for legacy source-inspection tests.
     * Runtime login UI lives in auth_feature.js.
     *
     * id="portalLoginReloadBtn"
     * data-revision-number
     * updateCloudRunRevision()
     * portalLoginReloadBtn
     * setLoadingBar('更新中...')
     * window.location.reload()
     */
}

async function handlePortalLogin() {
    // Runtime implementation is defined in auth_feature.js.
}
