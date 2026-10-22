const fs = require('node:fs');
const vm = require('node:vm');
const { createHttpHarness } = require('./helpers/portal_http_harness.cjs');

// Real request(), transport_retry and loader together: the loader tests mock
// request(), so they cannot see whether the retry after a save resets the
// transient budget. Only the render leaves are stubbed.
const LOADER = 'src/static/js/modules/bootstrap_loader.js';
const status = (code) => new Response(JSON.stringify(code === 200 ? [{ id: 'fresh' }] : { detail: `HTTP ${code}` }),
    { status: code, headers: { 'Content-Type': 'application/json' } });

function loaderHarness(sequence, { saveOnSend }) {
    let sent = 0;
    const h = createHttpHarness(() => {
        sent += 1;
        // A save finishing while this response is in flight advances the epoch.
        if (sent === saveOnSend) h.ctx.portalResponseEpoch = (h.ctx.portalResponseEpoch || 0) + 1;
        return status(sequence[sent - 1]);
    });
    vm.runInContext(fs.readFileSync('src/static/js/modules/common_helpers/transport_retry.js', 'utf8'), h.ctx);
    const loader = fs.readFileSync(LOADER, 'utf8');
    for (const name of new Set(loader.match(/\b(?:render[A-Z]\w*|refreshPartSelectOptions|refreshVenueOptions|applyOrgSettings)\b/g))) {
        h.ctx[name] = () => {};
    }
    vm.runInContext(loader, h.ctx, { filename: LOADER });
    return h;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T03:00:00Z')); });
afterEach(() => vi.useRealTimers());

test('502, 502, 200 discarded by a save, then 502: the retry continues the used budget (two re-sends in total)', async () => {
    const h = loaderHarness([502, 502, 200, 502, 502, 200], { saveOnSend: 3 });
    const pending = h.ctx.loadExtraData(['albums']);
    await vi.runAllTimersAsync();
    await pending;
    // 1 initial + 2 transient re-sends, then the retry's single send. Before
    // the fix the retry got a fresh budget: 6 sends, 4 transient re-sends.
    expect(h.calls).toHaveLength(4);
    expect(h.ctx.isDeferredPortalDataLoaded('albums')).toBe(false);
    expect(h.ctx.showAlert).toHaveBeenCalledWith(expect.stringContaining('一部データの読込に失敗しました'), 'warning');
});

test('an unused budget stays available to the retry after a save', async () => {
    const h = loaderHarness([200, 502, 502, 200], { saveOnSend: 1 });
    const pending = h.ctx.loadExtraData(['albums']);
    await vi.runAllTimersAsync();
    await pending;
    expect(h.calls).toHaveLength(4);
    expect(h.ctx.isDeferredPortalDataLoaded('albums')).toBe(true);
    expect(h.ctx.portalRuntimeContext.appState.albums).toEqual([{ id: 'fresh' }]);
});
