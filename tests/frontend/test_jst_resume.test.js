const fs = require('node:fs');
const vm = require('node:vm');

test('resume re-evaluates a Japan date change once without resetting forms', () => {
    let day = '2026-10-19';
    const ctx = {
        navigator: { onLine: true }, document: { visibilityState: 'visible', addEventListener: vi.fn() },
        portalRuntimeContext: { appState: { portalAuthVerified: true }, today: () => day, getById: () => null },
        setDefaultDates: vi.fn(), renderPortalHome: vi.fn(), renderPaymentAdmin: vi.fn(),
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('src/static/js/modules/common_helpers/bootstrap_init.js', 'utf8'), ctx);
    ctx.refreshPortalCalendarDay();
    expect(ctx.renderPortalHome).not.toHaveBeenCalled();
    day = '2026-10-20';
    ctx.document.visibilityState = 'hidden'; ctx.refreshPortalCalendarDay();
    expect(ctx.renderPortalHome).not.toHaveBeenCalled();
    ctx.document.visibilityState = 'visible'; ctx.refreshPortalCalendarDay(); ctx.refreshPortalCalendarDay();
    expect(ctx.renderPortalHome).toHaveBeenCalledTimes(1);
    expect(ctx.renderPaymentAdmin).toHaveBeenCalledTimes(1);
    expect(ctx.renderPaymentAdmin).toHaveBeenCalledWith({ preserveForm: true });
    expect(ctx.setDefaultDates).not.toHaveBeenCalled();
});
