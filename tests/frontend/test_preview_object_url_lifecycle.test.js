const fs = require('node:fs');
const vm = require('node:vm');

function runtime() {
    const nodes = new Map();
    for (const id of ['perfFlyerPreview', 'perfFlyerImage', 'promotionImagePreview', 'promotionImageFile', 'orgIconPreview', 'orgIconFile']) {
        nodes.set(id, { innerHTML: '', value: '', src: '', files: [] });
    }
    let sequence = 0;
    const ctx = { URL: { createObjectURL: vi.fn(() => `blob:preview-${++sequence}`), revokeObjectURL: vi.fn() },
        portalRuntimeContext: { appState: {}, getById: id => nodes.get(id) },
        escapeHtml: value => String(value), currentOrgSetting: () => ({ id: 1, icon_url: '/saved.png' }),
        addEventListener: vi.fn() };
    ctx.window = ctx; vm.createContext(ctx);
    for (const file of ['common_helpers/pure', 'portal_views', 'date_piece_promotion/state', 'date_piece_promotion/api', 'admin_system/render']) {
        vm.runInContext(fs.readFileSync(`src/static/js/modules/${file}.js`, 'utf8'), ctx);
    }
    return { ctx, nodes };
}

test('flyer preview releases replaced and cleared URLs, retaining the current image', async () => {
    const { ctx, nodes } = runtime();
    const file = { name: 'photo.png' };
    await ctx.previewPerformanceFlyer({ target: { files: [file] } });
    await ctx.previewPerformanceFlyer({ target: { files: [file] } });
    expect(ctx.URL.revokeObjectURL.mock.calls).toEqual([['blob:preview-1']]);
    expect(nodes.get('perfFlyerPreview').innerHTML).toContain('blob:preview-2');
    ctx.renderPerformanceFlyerPreview('/saved.png');
    ctx.renderPerformanceFlyerPreview('');
    expect(ctx.URL.revokeObjectURL.mock.calls).toEqual([['blob:preview-1'], ['blob:preview-2']]);
});

test('promotion clear releases its preview without revoking server URLs', async () => {
    const { ctx, nodes } = runtime();
    const file = { name: 'promotion.png' };
    nodes.get('promotionImageFile').files = [file];
    await ctx.previewPromotionImage({ target: { files: [file] } });
    await ctx.previewPromotionImage({ target: { files: [file] } });
    expect(nodes.get('promotionImageFile').files[0]).toBe(file);
    ctx.clearPromotionForm(); ctx.clearPromotionForm();
    expect(ctx.URL.revokeObjectURL.mock.calls).toEqual([['blob:preview-1'], ['blob:preview-2']]);
});

test('organization reset releases previews without registering global cleanup', async () => {
    const { ctx, nodes } = runtime();
    nodes.get('orgIconFile').files = [{ name: 'icon.png' }];
    await ctx.previewOrgIcon(); await ctx.previewOrgIcon();
    expect(ctx.URL.revokeObjectURL.mock.calls).toEqual([['blob:preview-1']]);
    expect(ctx.addEventListener).not.toHaveBeenCalled();
    ctx.renderOrgManagement();
    expect(nodes.get('orgIconPreview').src).toBe('/saved.png');
    await ctx.previewOrgIcon();
    ctx.clearOrgSettingForm();
    expect(ctx.URL.revokeObjectURL.mock.calls).toEqual([['blob:preview-1'], ['blob:preview-2'], ['blob:preview-3']]);
});
