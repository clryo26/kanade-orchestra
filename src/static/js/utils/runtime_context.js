// Runtime shared context for legacy global scripts.
(function runtimeContextBootstrap(globalObj) {
    if (globalObj.portalRuntimeContext) {
        return;
    }

    const readOwnDataProperty = (name) => {
        const descriptor = Object.getOwnPropertyDescriptor(globalObj, name);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return undefined;
        }
        return descriptor.value;
    };

    const resolveAppState = () => {
        if (typeof globalObj.getAppState === 'function') {
            return globalObj.getAppState();
        }
        const portalAppState = readOwnDataProperty('portalAppState');
        if (portalAppState) {
            return portalAppState;
        }
        // Do not read accessor-based window.appState here. Older compatibility
        // getters may point back to portalRuntimeContext.appState and recurse.
        return readOwnDataProperty('appState');
    };

    const context = {
        dbCache: globalObj.portalCacheState.dbCache,
        inFlightGetRequests: globalObj.portalCacheState.inFlightGetRequests,
        WHOLE_PRACTICE_RECORDING_PIECE: globalObj.WHOLE_PRACTICE_RECORDING_PIECE,
        get appState() {
            return resolveAppState();
        },
        today: () => {
            const now = new Date();
            const y = now.getFullYear();
            const m = String(now.getMonth() + 1).padStart(2, '0');
            const d = String(now.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        },
        getById: (id) => document.getElementById(id),
        PORTAL_AUTH_KEY: 'kanadePortalAuthenticated',
        PORTAL_DEVICE_ID_KEY: 'kanadePortalDeviceId',
        DEFAULT_MEMBER_PARTS: [
            'Violin',
            'Viola',
            'Cello',
            'Contrabass',
            'Flute',
            'Oboe',
            'Clarinet',
            'Fagot',
            'Horn',
            'Trumpet',
            'Trombone',
            'Tuba',
            'Percussion',
            'Piano'
        ]
    };

    globalObj.portalRuntimeContext = context;

    // Keep runtime values only under portalRuntimeContext.
    // Global aliases (appState/$) are phased out in Phase5.
})(typeof window !== 'undefined' ? window : globalThis);
