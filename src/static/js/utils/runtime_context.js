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

    // Japan Standard Time with a fixed +09:00 offset (no DST since 1951), the
    // same rule as the backend. Calendar parts come from the UTC getters of a
    // shifted instant, so the device timezone never changes the result.
    const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const pad2 = (value) => String(value).padStart(2, '0');
    const jst = {
        parts(ms) {
            const shifted = new Date(Number(ms) + JST_OFFSET_MS);
            return {
                year: shifted.getUTCFullYear(),
                month: shifted.getUTCMonth() + 1,
                day: shifted.getUTCDate(),
                hour: shifted.getUTCHours(),
                minute: shifted.getUTCMinutes(),
                second: shifted.getUTCSeconds(),
                weekday: shifted.getUTCDay(),
            };
        },
        dateKey(ms) {
            const p = jst.parts(ms);
            return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
        },
        now: () => Date.now(),
    };

    const context = {
        dbCache: globalObj.portalCacheState.dbCache,
        inFlightGetRequests: globalObj.portalCacheState.inFlightGetRequests,
        WHOLE_PRACTICE_RECORDING_PIECE: globalObj.WHOLE_PRACTICE_RECORDING_PIECE,
        get appState() {
            return resolveAppState();
        },
        jst,
        // "Today" is the Japan calendar day, independent of the device timezone.
        today: () => jst.dateKey(jst.now()),
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
