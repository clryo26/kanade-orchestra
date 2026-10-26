const fs = require('node:fs');
const vm = require('node:vm');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T03:00:00Z')); });
afterEach(() => vi.useRealTimers());

test.each([59999, 60000, 60001])('existing resume boundary at %ims and guard do not fetch hidden extras', async age => {
    const state = { portalAuthVerified: true, essentialDataLoaded: true,
        lastPortalSessionVerifiedAt: Date.now() - age, lastEssentialDataLoadedAt: Date.now() - age };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const ctx = { Date, navigator: { onLine: true }, document: { visibilityState: 'visible', addEventListener() {} },
        addEventListener() {}, localStorage: { getItem: () => 'true' },
        portalRuntimeContext: { appState: state, today: () => '2026-10-22', getById: () => null },
        isPortalAuthenticated: vi.fn(async () => ({ status: 'authenticated' })),
        loadEssentialData: vi.fn(() => gate), loadExtraData: vi.fn(), showAlert: vi.fn() };
    ctx.window = ctx; vm.createContext(ctx);
    const source = fs.readFileSync('src/static/js/modules/common_helpers/bootstrap_init.js', 'utf8');
    vm.runInContext(source.replace(/}\s*$/, '\nwindow.__resume = syncPortalSessionOnResume;\n}'), ctx);
    expect(typeof ctx.__resume).toBe('function');
    expect(ctx.__resume.name).toBe('syncPortalSessionOnResume');
    const a = ctx.__resume(), b = ctx.__resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.loadEssentialData).toHaveBeenCalledTimes(age < 60000 ? 0 : 1);
    expect(ctx.loadExtraData).not.toHaveBeenCalled();
    if (age >= 60000) expect(ctx.loadEssentialData).toHaveBeenCalledWith({ _requestOrigin: 'automatic' });
    release(); await Promise.all([a, b]);
});
