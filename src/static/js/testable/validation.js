(function (globalObj) {
    function mutationRelatedCacheKeys(url) {
        const keys = new Set(['/api/bootstrap-lite', '/api/bootstrap-core', '/api/bootstrap']);
        if (url.startsWith('/api/extra/')) {
            keys.add(url.split('?')[0]);
            if (url.includes('/sheet_library') || url.includes('/date_adjust') || url.includes('/practice_instruction')) keys.add('/api/sheets');
            return [...keys];
        }
        if (url.startsWith('/api/sheets')) {
            keys.add('/api/sheets');
            keys.add('/api/extra/sheet_library');
            return [...keys];
        }
        if (url.startsWith('/api/recordings') || url.startsWith('/api/convert') || url.startsWith('/api/drive/')) {
            keys.add('/api/recordings');
            keys.add('/api/drive/files');
            return [...keys];
        }
        const firstPath = url.split('?')[0].replace(/\/[0-9]+$/, '');
        keys.add(firstPath);
        return [...keys];
    }
    function loadAllEndpointFromOptions(options) { return (options || {}).includeHeavyLists !== false ? '/api/bootstrap' : '/api/bootstrap-core'; }
    function renderInitialViewTargets(includeHeavyLists) {
        const heavy = includeHeavyLists !== false;
        const targets = ['renderPerformances','renderSchedules','renderAnnouncements','renderEvents','renderMembers','renderPaymentAdmin','renderVenueManagement','renderCastingAdmin','renderPieceInfoAdmin','renderPracticeInstructionAdmin','renderOrgManagement','renderSnsManagement','renderConnectionSettingsManagement','renderMemberPerformances','renderMemberSchedules','renderMemberIntros','renderMemberExtraViews','renderAuthDevices','renderPartManagement','renderSchedulePerformanceOptions','updateSchedulePieceOptions','renderPortalHome'];
        if (heavy) targets.splice(5, 0, 'renderRecordings', 'renderSheetAdmin');
        return targets;
    }
    function renderBackgroundViewTargets(includeHeavyLists) {
        const targets = ['renderSchedules','renderEvents','renderMembers','renderMemberExtraViews','renderSheetAdmin','renderCastingAdmin','renderPracticeInstructionAdmin','renderPerformanceDayInfoAdmin','renderAuthDevices','renderSchedulePerformanceOptions','updateSchedulePieceOptions','renderPortalHome'];
        if (includeHeavyLists === false) return targets;
        return targets;
    }
    function adminTabRenderTargets(tabName) {
        const map = {
            schedule: ['renderSchedulePerformanceOptions','updateSchedulePieceOptions','renderSchedules'],
            event: ['renderEvents'],
            member: ['renderMembers'],
        };
        return map[tabName] || [];
    }
    function buildRequestHeadersForApi(headers, deviceId) { return { ...(headers || {}), ...(deviceId ? { 'X-Device-Id': deviceId } : {}) }; }
    function buildConditionalGetHeadersForApi(baseHeaders, etag) { return { ...(baseHeaders || {}), ...(etag ? { 'If-None-Match': etag } : {}) }; }
    function portalMenuStatePatch(tabName) {
        if (tabName === 'member-piece-info') return { selectedPieceInfoContext: null, pieceInfoEditing: false };
        if (tabName === 'member-practice-instruction') return { selectedPracticeInstructionContext: null, practiceInstructionEditing: false };
        return {};
    }
    function detailEditorUiState(isEditing) { const editing = Boolean(isEditing); return { isEditing: editing, actionButtonClass: editing ? 'btn-success' : 'btn-outline-primary', actionButtonLabel: editing ? '保存' : '編集', readOnly: !editing, readOnlyAttribute: editing ? '' : 'readonly' }; }
    function systemAccessLogContract() { return { tabName: 'system-access-log', targetPaneId: 'systemAccessLog', endpoint: '/api/system/access-logs', listEndpointPrefix: '/api/system/access-logs?limit=200&_= ', requiredHeader: 'X-Device-Id' }; }
    function loginRevisionUiContract() { return { reloadButtonId: 'portalLoginReloadBtn', revisionAttribute: 'data-revision-number', loadingLabel: '更新中...', refreshAction: 'window.location.reload()' }; }
    function memberPasswordBadgeState(passwordSet) { return { label: Boolean(passwordSet) ? '設定済み' : '未設定', className: Boolean(passwordSet) ? 'text-bg-success' : 'text-bg-warning' }; }
    function memberSelectionFormPatch(member) {
        const item = member || {};
        const fallbackName = item.name && !item.last_name && !item.first_name ? item.name : '';
        return { memberId: item.id, memberLastName: item.last_name || fallbackName, memberFirstName: item.first_name || '', memberMaidenName: item.maiden_name || '', memberPassword: '', memberPart: item.part || '', memberPermission: item.permission || '一般' };
    }
    function paymentStatusContract() { return { membershipRangeField: 'paid_until_month', performanceStatusField: 'performance_fees', visibleStatusLabels: ['支払済み', '未払い'], hiddenAmountFields: ['membership_fee_amount', 'performance_fee_amount'], hiddenAmountHelpers: ['performanceFeeAmountLabel', 'orgMembershipFeeAmountLabel'] }; }
    function castingEditorState(casting, fallbackPerformanceId = null) {
        if (casting) return { castingEditingId: casting.id || null, castingEditingPerformanceId: casting.performance_id || fallbackPerformanceId || null, castingEditingPiece: casting.piece || '', castingEditingMembers: Array.isArray(casting.members) ? casting.members.map((member) => ({ ...member })) : [], castingEditingExtras: Array.isArray(casting.extras) ? casting.extras.map((extra) => ({ ...extra })) : [] };
        return { castingEditingId: null, castingEditingPerformanceId: fallbackPerformanceId || null, castingEditingPiece: '', castingEditingMembers: [], castingEditingExtras: [] };
    }
    function castingTableLayoutContract() { return { tableClass: 'casting-table', partCellClass: 'casting-part-cell', membersCellClass: 'casting-members-cell', css: { partCellPaddingRight: '0.35rem', membersCellPaddingLeft: '0.15rem' } }; }
    function performanceFormLayoutContract() { return { pieceListId: 'perfPieceList', flyerFileId: 'perfFlyerFile', memberPerformance: { pieceLabelMode: 'formal', flyerPreviewClass: 'performance-flyer-preview', pieceListBeforeFlyer: true } }; }
    function sheetLibraryHeadingContract() { return { headingClass: 'sheet-library-heading', performanceHeadingTag: 'strong', pieceHeadingTag: 'span', textAlign: 'left' }; }
    function foldSettledExtraResults(settled, requestSpecs, currentState) {
        const resultMap = new Map();
        const failed = [];
        settled.forEach((item, index) => {
            const key = requestSpecs[index][0];
            if (item.status === 'fulfilled') resultMap.set(key, item.value); else failed.push(key);
        });
        const state = currentState || {};
        return { failed, values: { absences: resultMap.get('absences') || state.absences || [], eventResponses: resultMap.get('eventResponses') || state.eventResponses || [], dateAdjustments: resultMap.get('dateAdjustments') || state.dateAdjustments || [], dateAdjustmentResponses: resultMap.get('dateAdjustmentResponses') || state.dateAdjustmentResponses || [], sheets: resultMap.get('sheets') || { files: state.sheetLibrary || [] }, payments: resultMap.get('payments') || state.payments || [], castings: resultMap.get('castings') || state.castings || [], pieceInfos: resultMap.get('pieceInfos') || state.pieceInfos || [], practiceInstructions: resultMap.get('practiceInstructions') || state.practiceInstructions || [], desiredPieces: resultMap.get('desiredPieces') || state.desiredPieces || [], promotions: resultMap.get('promotions') || state.promotions || [], albums: resultMap.get('albums') || state.albums || [], partSettings: resultMap.get('partSettings') || state.partSettings || [], venueSettings: resultMap.get('venueSettings') || state.venueSettings || [], orgSettings: resultMap.get('orgSettings') || state.orgSettings || [], snsSettings: resultMap.get('snsSettings') || state.snsSettings || [], connectionSettings: resultMap.get('connectionSettings') || state.connectionSettings || [] } };
    }
    function performanceDayAssignmentRowsForPayload(rows) {
        return (Array.isArray(rows) ? rows : [])
            .map((row) => ({ role: String(row?.role || '').trim(), members: String(row?.members || '').trim() }))
            .filter((row) => row.role || row.members);
    }
    function performanceDayAssignmentRowsAfterAdd(rows) {
        const currentRows = Array.isArray(rows) && rows.length
            ? rows.map((row) => ({ role: String(row?.role || '').trim(), members: String(row?.members || '').trim() }))
            : [{ role: '', members: '' }];
        return [...currentRows, { role: '', members: '' }];
    }
    const api = { mutationRelatedCacheKeys, loadAllEndpointFromOptions, renderInitialViewTargets, renderBackgroundViewTargets, adminTabRenderTargets, buildRequestHeadersForApi, buildConditionalGetHeadersForApi, portalMenuStatePatch, detailEditorUiState, systemAccessLogContract, loginRevisionUiContract, memberPasswordBadgeState, memberSelectionFormPatch, paymentStatusContract, castingEditorState, castingTableLayoutContract, performanceFormLayoutContract, sheetLibraryHeadingContract, foldSettledExtraResults, performanceDayAssignmentRowsForPayload, performanceDayAssignmentRowsAfterAdd };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalObj.FrontendTestableValidation = api;
})(typeof window !== 'undefined' ? window : globalThis);
