// Member render functions split from modules/members.js.
// Keep global names for compatibility with legacy non-module loading.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function joinedAtMonthLabel(value) {
    const match = String(value || '').trim().match(/^(\d{4})[-\/\.](\d{2})/);
    return match ? `${match[1]}年${match[2]}月` : '';
}

function renderMembers() {
    const list = $('memberListItems');
    if (list) {
        list.innerHTML = emptyText(appState.members, '団員情報はまだありません');
        sortedMembersByPartAndKana(appState.members).forEach((member) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'list-group-item list-group-item-action';
            item.innerHTML = `
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                    <strong>${escapeHtml(memberDisplayName(member))}</strong>
                    <span class="d-flex flex-wrap gap-2">
                        <span class="badge text-bg-secondary">${escapeHtml(member.permission || '一般')}</span>
                        ${member.permission === 'エキストラ' ? `<span class="badge text-bg-info">利用終了: ${escapeHtml(member.system_access_until || '未設定')}</span>` : ''}
                        <span class="badge ${member.password_set ? 'text-bg-success' : 'text-bg-warning'}">パスワード: ${member.password_set ? '設定済み' : '未設定'}</span>
                    </span>
                </div>
            `;
            item.addEventListener('click', () => selectMember(member.id));
            list.appendChild(item);
        });
    }
    if (!appState.suppressDerivedRender) {
        renderMemberIntros();
        renderMemberExtraViews();
    }
}

function renderMemberIntros() {
    const container = $('memberIntroInfo');
    if (!container) return;
    if (!appState.members.length) {
        container.innerHTML = '<p class="text-muted mb-0">団員情報はまだありません</p>';
        return;
    }
    const grouped = groupBy(sortedMembersByPartAndKana(appState.members), 'part');
    const entries = Object.entries(grouped);
    const nav = `<div class="member-part-nav mb-3">${entries.map(([part]) => {
        const id = `intro-part-${cssSafeId(part || 'none')}`;
        return `<a class="btn btn-sm btn-outline-primary" href="#${escapeHtml(id)}">${escapeHtml(part || '未設定')}</a>`;
    }).join('')}</div>`;
    container.innerHTML = nav + entries.map(([part, members]) => {
        const sectionId = `intro-part-${cssSafeId(part || 'none')}`;
        return `
        <section class="mb-4" id="${escapeHtml(sectionId)}">
            <h5>${escapeHtml(part || '未設定')}</h5>
            <div class="row g-3">${members.map((member) => `
                <div class="col-md-6 col-xl-4"><div class="card h-100"><div class="card-body member-intro-card-body">
                    ${member.photo_url ? `<img src="${escapeHtml(member.photo_url)}" alt="${escapeHtml(memberDisplayName(member))}" class="member-photo" loading="lazy">` : ''}
                    <div class="member-intro-text mt-2">
                        <h6 class="mb-1">${escapeHtml(memberDisplayName(member))}${member.is_founder ? '<span class="member-founder-badge ms-2">創設メンバー</span>' : ''}</h6>
                        ${memberKanaName(member) ? `<div class="small text-muted">${escapeHtml(memberKanaName(member))}</div>` : ''}
                        <div class="small text-muted">${escapeHtml(member.part || '')}</div>
                        ${member.joined_at ? `<div class="small mt-2"><strong>入団:</strong> ${escapeHtml(joinedAtMonthLabel(member.joined_at) || member.joined_at)}</div>` : ''}
                        ${member.introducer ? `<div class="small"><strong>紹介者:</strong> ${escapeHtml(member.introducer)}</div>` : ''}
                        ${member.role ? `<div class="small"><strong>役割:</strong> ${escapeHtml(member.role)}</div>` : ''}
                        ${member.instrument_history ? `<div class="small mt-2 multiline-text"><strong>楽器歴:</strong><br>${escapeHtml(member.instrument_history)}</div>` : ''}
                        ${member.past_orchestras ? `<div class="small mt-2 multiline-text"><strong>過去所属オケ:</strong><br>${escapeHtml(member.past_orchestras)}</div>` : ''}
                        ${member.comment ? `<div class="small mt-2 multiline-text member-comment"><strong>コメント:</strong><br>${escapeHtml(member.comment)}</div>` : ''}
                    </div>
                    ${String(member.id || '') === String(appState.currentUserMemberId || '') ? `<div class="mt-3"><button class="btn btn-sm btn-outline-primary member-profile-edit-btn" type="button" data-member-id="${escapeHtml(String(member.id || ''))}">編集</button></div>` : ''}
                </div></div></div>`).join('')}</div>
        </section>`;
    }).join('');
    container.querySelectorAll('.member-profile-edit-btn').forEach((button) => {
        button.addEventListener('click', () => showOwnProfileEditForm(button.dataset.memberId || ''));
    });
}

function renderMemberViews() {
    renderMemberPerformances();
    renderMemberSchedules();
    renderAnnouncements();
    renderRecordings();
    renderMemberIntros();
    renderPortalHome();
    renderMemberExtraViews({ includeHeavyLists: false });
}

function renderMemberPerformances() {
    const container = $('memberPerfInfo');
    if (!appState.performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
        return;
    }
    const nextPerf = nextPerformance() || [...appState.performances].filter((perf) => perf.date).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    container.innerHTML = `${nextPerf && countdown !== null ? `<div class="countdown-banner">本番まであと${countdown}日！</div>` : ''}` + appState.performances.map((perf) => `
        <article class="info-block">
            <h5>${escapeHtml(perf.title)}</h5>
            <p>${escapeHtml(formatDateWithWeekday(perf.date))} ${escapeHtml(formatClockTime(perf.open_time))}開場 / ${escapeHtml(formatClockTime(perf.start_time))}開演</p>
            <p>${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</p>
            <div class="${perf.flyer_image ? 'mb-3' : 'mb-0'}">${(perf.pieces || []).map((piece) => `<div>${escapeHtml(performancePieceFormalLabel(piece))}</div>`).join('')}</div>
            ${perf.flyer_image ? `<div class="mb-0"><img src="${escapeHtml(perf.flyer_image)}" alt="チラシ画像" class="performance-flyer-preview" loading="lazy"></div>` : ''}
        </article>
    `).join('');
}

function renderMemberExtraViews(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    renderAbsenceView();
    if (includeHeavyLists) renderSheetLibraryView();
    renderPracticeInstructionView();
    renderFlyerDistributionView();
    renderPaymentView();
    renderCastingView();
    renderMemberEventView();
    renderPerformanceDayInfoView();
    renderDateAdjustmentView();
    renderPieceInfoView();
    renderDesiredPieceView();
    renderManualView();
    renderPromotionView();
    renderAlbumView();
    renderConcertRecordView();
    renderSnsView();
}

function renderCastingMembersList() {
    const list = $('castingMembersList');
    if (!list) return;

    const selectedIds = new Set((appState.castingEditingMembers || []).map((member) => String(member.member_id || '')).filter(Boolean));
    const sortedMembers = sortedMembersByPartAndKana(appState.members || []);
    if (!sortedMembers.length) {
        list.innerHTML = '<p class="text-muted mb-0">団員データがありません</p>';
        return;
    }

    list.innerHTML = `<div class="row g-2">${sortedMembers.map((member) => {
        const memberId = String(member.id || '');
        const isChecked = selectedIds.has(memberId);
        const part = member.part ? `（${member.part}）` : '';
        return `
            <div class="col-md-6 col-lg-4">
                <label class="form-check border rounded p-2 h-100">
                    <input class="form-check-input casting-member-checkbox" type="checkbox" value="${escapeHtml(memberId)}" ${isChecked ? 'checked' : ''}>
                    <span class="form-check-label">${escapeHtml(memberDisplayName(member) + part)}</span>
                </label>
            </div>
        `;
    }).join('')}</div>`;

    list.querySelectorAll('.casting-member-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
            const checkedIds = Array.from(list.querySelectorAll('.casting-member-checkbox:checked')).map((input) => String(input.value || ''));
            appState.castingEditingMembers = checkedIds.map((memberId) => {
                const member = appState.members.find((item) => String(item.id || '') === memberId);
                return {
                    member_id: Number(memberId) || 0,
                    part: member?.part || '',
                };
            });
        });
    });
}