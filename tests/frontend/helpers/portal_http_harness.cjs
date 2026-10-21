const fs = require('node:fs');
const vm = require('node:vm');

function createHttpHarness(respond) {
    const values = new Map([['device', 'fixture-device'], ['auth', 'true']]);
    const cache = new Map();
    const calls = [];
    const state = { currentUserMemberId: 7, currentUserPermission: '一般', portalAuthGeneration: 'fixture-generation', portalAuthVerified: true };
    const ctx = {
        console, AbortController, DOMException, Headers, Response,
        setTimeout, clearTimeout, Date, Math,
        localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
        showAlert: vi.fn(), showPortalLogin: vi.fn(), addEventListener: vi.fn(),
        portalRuntimeContext: {
            appState: state, PORTAL_DEVICE_ID_KEY: 'device', PORTAL_AUTH_KEY: 'auth',
            inFlightGetRequests: new Map(), dbCache: {
                getEntry: vi.fn(async (key) => cache.get(key) || null),
                set: vi.fn(async (key, data, etag) => cache.set(key, { data, etag, timestamp: Date.now(), validatedAt: Date.now() })),
                delete: vi.fn(async (key) => cache.delete(key)),
            },
        },
        fetch: vi.fn(async (url, options) => { calls.push({ url, options }); return respond(url, options, calls.length); }),
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of ['src/static/js/utils/cache.js', 'src/static/js/modules/common_helpers/api_runtime.js']) {
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    return { ctx, cache, calls, state, values, db: ctx.portalRuntimeContext.dbCache };
}

module.exports = { createHttpHarness };
