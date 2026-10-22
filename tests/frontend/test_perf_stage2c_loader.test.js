const { createCdeHarness, deferred } = require('./helpers/portal_cde_harness.cjs');

test('shared album response is applied once and no unrelated leaf is rendered', async () => {
    const gate = deferred(), h = createCdeHarness(() => gate.promise);
    const a = h.ctx.loadExtraData(['albums']), b = h.ctx.loadExtraData(['albums']);
    gate.resolve([{ id: 1 }]); await Promise.all([a, b]);
    expect(h.sends).toHaveLength(1);
    expect(h.applied.albums).toBe(1);
    expect(h.counts).toEqual({ renderAlbumView: 1 });
    await h.ctx.loadExtraData(['albums']);
    expect(h.sends).toHaveLength(2); // completed results are not cached by the loader
});

test('an old batch waiting for another collection cannot restore its older album', async () => {
    const slow = deferred(); let version = 1;
    const h = createCdeHarness(url => url.endsWith('promotions') ? slow.promise : [{ id: version }]);
    const old = h.ctx.loadExtraData(['albums', 'promotions']);
    await new Promise(resolve => setImmediate(resolve));
    version = 2;
    await h.ctx.loadExtraData(['albums']);
    slow.resolve([]); await old;
    expect(h.state.albums).toEqual([{ id: 2 }]);
    expect(h.applied.albums).toBe(1);
    expect(h.counts.renderAlbumView).toBe(1);
});

test.each(['epoch', 'member', 'generation', 'transition'])('discard batch after %s changes during its aggregate wait', async change => {
    const slow = deferred(), h = createCdeHarness(url => url.endsWith('promotions') ? slow.promise : [{ id: 1 }]);
    const pending = h.ctx.loadExtraData(['albums', 'promotions']);
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'epoch') h.ctx.portalResponseEpoch++;
    if (change === 'member') h.state.currentUserMemberId = 2;
    if (change === 'generation') h.state.portalAuthGeneration = 'two';
    if (change === 'transition') h.state.portalAuthTransition = 1;
    slow.resolve([]); await pending;
    expect(h.state.albums).toBeUndefined();
    expect(h.counts).toEqual({});
});

test.each([
    ['eventResponses', 'renderMemberEventView'], ['dateAdjustments', 'renderDateAdjustmentView'],
    ['dateAdjustmentResponses', 'renderDateAdjustmentView'], ['pieceInfos', 'renderPieceInfoView'],
    ['practiceInstructions', 'renderPracticeInstructionView'], ['castings', 'renderCastingView'],
    ['performanceDayInfos', 'renderPerformanceDayInfoView'], ['flyerDistributions', 'renderFlyerDistributionView'],
    ['flyerDistributionAssignments', 'renderFlyerDistributionView'], ['desiredPieces', 'renderDesiredPieceView'],
    ['promotions', 'renderPromotionView'], ['albums', 'renderAlbumView'],
    ['concertRecordVideos', 'renderConcertRecordView'], ['absences', 'renderAbsenceView'],
    ['payments', 'renderPaymentView'], ['snsSettings', 'renderSnsView'],
])('%s empty/deleted data refreshes its dependent view without resetting unrelated settings', async (collection, leaf) => {
    const h = createCdeHarness(); h.state[collection] = [{ id: 1 }];
    await h.ctx.loadExtraData([collection]);
    expect(h.state[collection]).toEqual([]);
    expect(h.counts[leaf]).toBe(1);
    expect(h.counts.renderOrgManagement).toBeUndefined();
    expect(h.counts.renderConnectionSettingsManagement).toBeUndefined();
});

test('joined collections render their shared leaf only once', async () => {
    const h = createCdeHarness();
    await h.ctx.loadExtraData(['pieceInfos', 'practiceInstructions', 'dateAdjustments', 'dateAdjustmentResponses']);
    expect(h.counts.renderPracticeInstructionView).toBe(1);
    expect(h.counts.renderDateAdjustmentView).toBe(1);
});

test('partial failure retains old data, retries later, and reports a shared failure once', async () => {
    const gate = deferred(), h = createCdeHarness(url => url.endsWith('albums') ? [] : gate.promise);
    h.state.promotions = [{ id: 'keep' }];
    const a = h.ctx.loadExtraData(['albums', 'promotions']), b = h.ctx.loadExtraData(['promotions']);
    gate.reject(new Error('offline')); await Promise.all([a, b]);
    expect(h.state.albums).toEqual([]);
    expect(h.state.promotions).toEqual([{ id: 'keep' }]);
    expect(h.ctx.alerts).toHaveLength(1);
    expect(h.ctx.isDeferredPortalDataLoaded('promotions')).toBe(false);
});

test('full dispatcher contract and renderer exceptions are preserved (no suppression flag leak)', async () => {
    const h = createCdeHarness();
    h.ctx.renderMemberExtraViews();
    expect(h.counts.renderManualView).toBe(1);
    h.ctx.renderAlbumView = () => { throw new Error('render failure'); };
    await expect(h.ctx.loadExtraData(['albums'])).rejects.toThrow('render failure');
    expect(h.state.suppressDerivedRender).not.toBe(true);
});

test('force revalidation options survive the loader and are not mutated', async () => {
    const h = createCdeHarness(); const options = Object.freeze({ _forceRevalidate: true, _requestOrigin: 'automatic' });
    await h.ctx.loadExtraData(['albums'], options);
    expect(h.sends[0].options).toEqual(options);
});

test.each([
    ['orgSettings', ['applyOrgSettings', 'renderOrgManagement', 'renderManualView', 'renderPaymentView', 'renderPaymentAdmin']],
    ['venueSettings', ['refreshVenueOptions', 'renderVenueManagement']],
    ['connectionSettings', ['renderConnectionSettingsManagement']],
    ['partSettings', ['renderMembers', 'renderPartManagement', 'renderMemberSchedules', 'renderPaymentAdmin', 'renderPerformanceDayInfoAdmin']],
])('%s refreshes its settings dependencies without the other settings forms', async (collection, required) => {
    const h = createCdeHarness();
    await h.ctx.loadExtraData([collection]);
    for (const leaf of required) expect(h.counts[leaf]).toBe(1);
    for (const leaf of ['renderOrgManagement', 'renderConnectionSettingsManagement', 'renderVenueManagement']) {
        if (!required.includes(leaf)) expect(h.counts[leaf]).toBeUndefined();
    }
});

test('casting changes refresh payment eligibility without rebuilding payment input controls', async () => {
    const h = createCdeHarness();
    h.ctx.renderPaymentAdmin = vi.fn();
    await h.ctx.loadExtraData(['castings']);
    expect(h.counts.renderPaymentView).toBe(1);
    expect(h.ctx.renderPaymentAdmin).toHaveBeenCalledWith({ preserveForm: true });
});
