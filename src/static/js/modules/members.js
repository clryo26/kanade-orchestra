// This file was split from main.js during frontend refactor.
// It depends on shared globals declared in main.js (appState, $, request, helpers).

function setupMemberManagerTabs() {
    const memberPanel = $('memberPanel');
    const toolbar = memberPanel?.querySelector('.toolbar');
    if (!memberPanel || !toolbar) return;

    if (!$('memberUploadAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberUploadAdminBtn" data-tab="upload" type="button" hidden>録音管理</button>');
    }
    if (!$('memberSheetAdminBtn')) {
        toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-outline-primary" id="memberSheetAdminBtn" data-tab="sheet-admin" type="button" hidden>楽譜管理</button>');
    }

    const uploadTab = $('uploadTab');
    if (uploadTab && uploadTab.parentElement !== memberPanel) {
        memberPanel.appendChild(uploadTab);
    }
    const sheetAdminTab = $('sheetAdminTab');
    if (sheetAdminTab && sheetAdminTab.parentElement !== memberPanel) {
        memberPanel.appendChild(sheetAdminTab);
    }
}

// ログイン中ユーザーの権限に応じて、管理導線ボタンの表示/非表示を切り替える。


function isExtraRestrictedMemberTab(tabName) {
    return isExtraUser() && EXTRA_RESTRICTED_MEMBER_TABS.has(tabName);
}


function visibleMemberMenuItems(items) {
    return items.filter((item) => item && !isExtraRestrictedMemberTab(item.tab || ''));
}

// ホーム/ドロワーに表示するメニュー群の定義を返す。
// 表示可否は現在の権限やアラート状態に応じて動的に決まる。


function currentUserMember() {
    return appState.members.find((member) => String(member.id || '') === String(appState.currentUserMemberId || '')) || null;
}

// 現在ログイン中の表示名を返す（団員レコード優先）。


function currentUserMemberName() {
    const member = currentUserMember();
    return member ? memberDisplayName(member) : appState.currentUserName || '';
}

// 管理者メニューへ入れるか判定する。


function memberDisplayName(member) {
    const last = member?.last_name || '';
    const first = member?.first_name || '';
    const maiden = member?.maiden_name || '';
    const splitName = `${last}${maiden ? `(${maiden})` : ''}${first}`;
    return splitName || member?.name || '';
}

// 現在ログイン中の団員レコードを状態ストアから取得する。
// currentUserMember moved to feature module.

// currentUserMemberName moved to feature module.


function memberKanaName(member) {
    return `${member?.last_name_kana || ''}${member?.first_name_kana || ''}`;
}


async function saveMember() {
    const current = appState.members.find((member) => String(member.id) === String($('memberId').value));
    const photoFile = $('memberPhotoFile')?.files?.[0];
    const photoUrl = photoFile ? await fileToDataUrl(photoFile) : (current?.photo_url || '');
    const password = $('memberPassword') ? $('memberPassword').value.trim() : '';
    const lastName = $('memberLastName') ? $('memberLastName').value.trim() : '';
    const firstName = $('memberFirstName') ? $('memberFirstName').value.trim() : '';
    const payload = {
        name: `${lastName}${firstName}`,
        last_name: lastName,
        first_name: firstName,
        maiden_name: $('memberMaidenName') ? $('memberMaidenName').value.trim() : '',
        last_name_kana: $('memberLastNameKana') ? $('memberLastNameKana').value.trim() : '',
        first_name_kana: $('memberFirstNameKana') ? $('memberFirstNameKana').value.trim() : '',
        maiden_name_kana: $('memberMaidenNameKana') ? $('memberMaidenNameKana').value.trim() : '',
        part: $('memberPart').value,
        photo_url: photoUrl,
        is_founder: $('memberIsFounder') ? $('memberIsFounder').checked : false,
        is_recording_manager: $('memberIsRecordingManager') ? $('memberIsRecordingManager').checked : false,
        is_sheet_manager: $('memberIsSheetManager') ? $('memberIsSheetManager').checked : false,
        password,
        permission: $('memberPermission') ? $('memberPermission').value : '一般',
        joined_at: $('memberJoinedAt') ? $('memberJoinedAt').value : '',
        system_access_until: $('memberSystemAccessUntil') ? $('memberSystemAccessUntil').value : '',
        introducer: $('memberIntroducer') ? $('memberIntroducer').value.trim() : '',
        role: $('memberRole') ? $('memberRole').value.trim() : '',
        instrument_history: $('memberInstrumentHistory') ? $('memberInstrumentHistory').value.trim() : '',
        past_orchestras: $('memberPastOrchestras') ? $('memberPastOrchestras').value.trim() : '',
        comment: $('memberComment').value.trim()
    };
    if (!payload.last_name || !payload.first_name) {
        showAlert('姓と名を入力してください', 'warning');
        return;
    }
    if (!payload.part) {
        showAlert('パートを選択してください', 'warning');
        return;
    }
    if (payload.permission === 'エキストラ' && !payload.system_access_until) {
        showAlert('エキストラの場合はシステム利用終了日を入力してください', 'warning');
        return;
    }
    if (payload.permission !== 'エキストラ') {
        payload.system_access_until = '';
    }
    const id = $('memberId').value;
    await request(id ? `/api/members/${id}` : '/api/members', jsonOptions(id ? 'PUT' : 'POST', payload));
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を保存しました', 'success');
}


function selectMember(id) {
    const item = appState.members.find((member) => member.id === id);
    if (!item) return;
    $('memberId').value = item.id;
    const fallbackName = item.name && !item.last_name && !item.first_name ? item.name : '';
    if ($('memberLastName')) $('memberLastName').value = item.last_name || fallbackName;
    if ($('memberFirstName')) $('memberFirstName').value = item.first_name || '';
    if ($('memberMaidenName')) $('memberMaidenName').value = item.maiden_name || '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = item.last_name_kana || '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = item.first_name_kana || '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = item.maiden_name_kana || '';
    $('memberPart').value = item.part || '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = Boolean(item.is_founder);
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = Boolean(item.is_recording_manager);
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = Boolean(item.is_sheet_manager);
    if ($('memberPassword')) $('memberPassword').value = '';
    if ($('memberPermission')) $('memberPermission').value = item.permission || '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = item.joined_at || '';
    if ($('memberSystemAccessUntil')) $('memberSystemAccessUntil').value = item.system_access_until || '';
    if ($('memberIntroducer')) $('memberIntroducer').value = item.introducer || '';
    if ($('memberRole')) $('memberRole').value = item.role || '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = item.instrument_history || '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = item.past_orchestras || '';
    $('memberComment').value = item.comment || '';
    syncMemberPermissionFields();
}


async function deleteMember() {
    const id = $('memberId').value;
    if (!id) {
        showAlert('削除する団員を一覧から選択してください', 'warning');
        return;
    }
    if (!confirmDelete()) return;
    await request(`/api/members/${id}`, { method: 'DELETE' });
    clearMemberForm();
    await loadMembers();
    showAlert('団員情報を削除しました', 'success');
}


function clearMemberForm() {
    $('memberId').value = '';
    if ($('memberLastName')) $('memberLastName').value = '';
    if ($('memberFirstName')) $('memberFirstName').value = '';
    if ($('memberMaidenName')) $('memberMaidenName').value = '';
    if ($('memberLastNameKana')) $('memberLastNameKana').value = '';
    if ($('memberFirstNameKana')) $('memberFirstNameKana').value = '';
    if ($('memberMaidenNameKana')) $('memberMaidenNameKana').value = '';
    $('memberPart').value = '';
    if ($('memberPhotoFile')) $('memberPhotoFile').value = '';
    if ($('memberIsFounder')) $('memberIsFounder').checked = false;
    if ($('memberIsRecordingManager')) $('memberIsRecordingManager').checked = false;
    if ($('memberIsSheetManager')) $('memberIsSheetManager').checked = false;
    if ($('memberPassword')) $('memberPassword').value = '';
    if ($('memberPermission')) $('memberPermission').value = '一般';
    if ($('memberJoinedAt')) $('memberJoinedAt').value = '';
    if ($('memberSystemAccessUntil')) $('memberSystemAccessUntil').value = '';
    if ($('memberIntroducer')) $('memberIntroducer').value = '';
    if ($('memberRole')) $('memberRole').value = '';
    if ($('memberInstrumentHistory')) $('memberInstrumentHistory').value = '';
    if ($('memberPastOrchestras')) $('memberPastOrchestras').value = '';
    $('memberComment').value = '';
    syncMemberPermissionFields();
}


function syncMemberPermissionFields() {
    const permission = $('memberPermission')?.value || '一般';
    const accessUntil = $('memberSystemAccessUntil');
    if (!accessUntil) return;
    const isExtra = permission === 'エキストラ';
    accessUntil.disabled = !isExtra;
    accessUntil.required = isExtra;
    if (!isExtra) accessUntil.value = '';
}


function sortedMembersByPartAndKana(members) {
    return [...(members || [])].sort((a, b) =>
        partSortIndex(a.part) - partSortIndex(b.part) ||
        String(a.part || '').localeCompare(String(b.part || ''), 'ja') ||
        String(memberKanaName(a) || memberDisplayName(a)).localeCompare(String(memberKanaName(b) || memberDisplayName(b)), 'ja') ||
        String(memberDisplayName(a)).localeCompare(String(memberDisplayName(b)), 'ja')
    );
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
                        <h6 class="mb-1">${escapeHtml(memberDisplayName(member))}${member.is_founder ? '<span class="badge text-bg-info ms-2">創設メンバー</span>' : ''}</h6>
                        ${memberKanaName(member) ? `<div class="small text-muted">${escapeHtml(memberKanaName(member))}</div>` : ''}
                        <div class="small text-muted">${escapeHtml(member.part || '')}</div>
                        ${member.joined_at ? `<div class="small mt-2"><strong>入団:</strong> ${escapeHtml(member.joined_at)}</div>` : ''}
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
            <p>${escapeHtml(formatDateWithWeekday(perf.date))} ${escapeHtml(perf.open_time)}開場 / ${escapeHtml(perf.start_time)}開演</p>
            <p>${escapeHtml(perf.venue || '会場未定')} / 指揮: ${escapeHtml(perf.conductor || '未定')}</p>
            <div class="${perf.flyer_image ? 'mb-3' : 'mb-0'}">${(perf.pieces || []).map((piece) => `<div>${escapeHtml(performancePieceFormalLabel(piece))}</div>`).join('')}</div>
            ${perf.flyer_image ? `<div class="mb-0"><img src="${escapeHtml(perf.flyer_image)}" alt="チラシ画像" class="performance-flyer-preview" loading="lazy"></div>` : ''}
        </article>
    `).join('');
}

// renderMemberSchedules moved to feature module.

// sortedSchedules moved to feature module.

// groupSchedulesByPerformance moved to feature module.

// compareSchedulePerformanceGroups moved to feature module.

// schedulePerformanceGroupIsUndecided moved to feature module.

// schedulePerformance moved to feature module.

// scheduleIsConductorTraining moved to feature module.

// scheduleIsMainPerformance moved to feature module.

// formatScheduleDate moved to feature module.


function renderMemberExtraViews(options = {}) {
    const includeHeavyLists = options.includeHeavyLists !== false;
    renderAbsenceView();
    if (includeHeavyLists) renderSheetLibraryView();
    renderPracticeInstructionView();
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

    const selectedIds = new Set(
        (appState.castingEditingMembers || [])
            .map((member) => String(member.member_id || ''))
            .filter(Boolean)
    );
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
                    part: member?.part || ''
                };
            });
        });
    });
}


function renderMemberEventView() {
    const c = $('memberEventInfo'); if (!c) return;
    c.innerHTML = `
        <div id="memberEventListView">
            <h6>イベント一覧</h6>
            <div class="list-group mb-3" id="memberEventList"></div>
            <h6>イベント登録</h6>
            <div class="row g-2 mb-3">
                <div class="col-md-4"><label class="form-label">イベント名</label><input id="memberEventTitle" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">開催日</label><input id="memberEventDate" type="date" class="form-control"></div>
                <div class="col-md-2"><label class="form-label">開始時刻</label><input id="memberEventStartTime" type="time" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">回答期限</label><input id="memberEventDeadline" type="date" class="form-control"></div>
                <div class="col-md-6"><label class="form-label">会費</label><input id="memberEventFee" class="form-control" placeholder="例: 4,000円"></div>
                <div class="col-12"><label class="form-label">イベント概要/備考</label><textarea id="memberEventNotes" class="form-control" rows="3"></textarea></div>
                <div class="col-md-6"><label class="form-label">削除時の合言葉</label><input id="memberEventDeletePhrase" class="form-control"></div>
                <div class="col-md-3 d-flex align-items-end"><button id="memberEventCreateBtn" class="btn btn-primary w-100" type="button">イベント登録</button></div>
            </div>
        </div>
        <div id="memberEventDetailView" hidden></div>`;
    $('memberEventDate').value = today();
    $('memberEventDeadline').value = today();
    $('memberEventCreateBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '作成中...', async () => {
        const payload = {
            title: $('memberEventTitle').value.trim(),
            date: $('memberEventDate').value,
            start_time: $('memberEventStartTime').value,
            deadline: $('memberEventDeadline').value,
            notes: $('memberEventNotes').value.trim(),
            delete_phrase: $('memberEventDeletePhrase').value.trim(),
            fee: $('memberEventFee') ? $('memberEventFee').value.trim() : '',
            url: ''
        };
        if (!payload.title || !payload.date || !payload.start_time || !payload.deadline || !payload.delete_phrase) {
            showAlert('イベント名、開催日、開始時刻、回答期限、削除時の合言葉を入力してください', 'warning');
            return;
        }
        await request('/api/events', jsonOptions('POST', payload));
        showAlert('イベントを作成しました', 'success');
        await loadEvents(); await loadExtraData();
    }));
    renderMemberEventList();
}


function renderMemberEventList() {
    const list = $('memberEventList');
    if (!list) return;
    const events = sortedEvents(appState.events);
    list.innerHTML = events.length ? '' : '<p class="text-muted mb-0">イベントはまだありません</p>';
    events.forEach((event) => {
        const item = document.createElement('button');
        item.className = 'list-group-item list-group-item-action text-start';
        item.type = 'button';
        const responseCount = uniqueEventResponses(appState.eventResponses.filter((r) => String(r.event_id) === String(event.id))).length;
        item.innerHTML = `
            <strong>${escapeHtml(event.title)}</strong>
            <div class="small text-muted">開催: ${escapeHtml(eventDateTimeLabel(event))} / 回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
            ${event.notes ? `<div class="small multiline-text mt-1">${escapeHtml(event.notes)}</div>` : ''}
            <div class="small text-muted mt-1">回答数: ${responseCount}</div>
        `;
        item.addEventListener('click', () => renderMemberEventDetail(event.id));
        list.appendChild(item);
    });
}


function renderMemberEventDetail(id) {
    const listView = $('memberEventListView');
    const detailView = $('memberEventDetailView');
    const event = appState.events.find((item) => String(item.id) === String(id));
    if (!listView || !detailView || !event) return;
    listView.hidden = true;
    detailView.hidden = false;
    const responses = appState.eventResponses.filter((r) => String(r.event_id) === String(id));
    const groupedResponsesHtml = renderGroupedEventResponses(responses);
    detailView.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary mb-3" id="memberEventBackBtn" type="button">イベント一覧に戻る</button>
        <section class="info-block pt-0">
            <h5>${escapeHtml(event.title)}</h5>
            <div>開催: ${escapeHtml(eventDateTimeLabel(event))}</div>
            <div>回答期限: ${escapeHtml(formatDateWithWeekday(event.deadline))}${event.fee ? ` / 会費: ${escapeHtml(event.fee)}` : ''}</div>
            ${event.notes ? `<div class="multiline-text mt-2">${escapeHtml(event.notes)}</div>` : ''}
        </section>
        <div class="row g-2 align-items-end mb-3">
            <div class="col-md-7"><label class="form-label">参加/不参加</label><select id="eventResponseStatus" class="form-select"><option>参加</option><option>不参加</option></select></div>
            <div class="col-md-3"><button id="eventResponseSaveBtn" class="btn btn-primary w-100" type="button">登録</button></div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-outline-danger" id="memberEventDeleteBtn" type="button">イベント削除</button>
        </div>
        <h6>回答状況</h6>
        ${groupedResponsesHtml}
    `;
    $('memberEventBackBtn').addEventListener('click', () => {
        detailView.hidden = true;
        listView.hidden = false;
        renderMemberEventList();
    });
    $('eventResponseSaveBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', async () => {
        const name = currentUserMemberName(); const status = $('eventResponseStatus').value;
        if (!name) { showAlert('ログイン中の団員情報が見つかりません', 'warning'); return; }
        const existingResponses = appState.eventResponses.filter((r) => String(r.event_id) === String(id) && String(r.name || '') === String(name));
        const existing = existingResponses[0];
        const payload = { event_id: id, name, status };
        if (existing?.id) {
            await request(`/api/extra/event_responses/${existing.id}`, jsonOptions('PUT', payload));
            await Promise.all(existingResponses.slice(1).filter((r) => r.id).map((r) => request(`/api/extra/event_responses/${r.id}`, { method: 'DELETE' })));
            showAlert('イベント出欠を上書きしました', 'success');
        } else {
            await saveExtra('event_responses', payload);
            showAlert('イベント出欠を登録しました', 'success');
        }
        await loadExtraData();
        renderMemberEventDetail(id);
    }));
    $('memberEventDeleteBtn').addEventListener('click', (clickEvent) => withButtonStatus(clickEvent.currentTarget, '削除中...', async () => {
        const phrase = prompt('削除時の合言葉を入力してください');
        if (phrase === null) return;
        if (phrase !== (event.delete_phrase || '')) {
            showAlert('削除時の合言葉が違います', 'danger');
            return;
        }
        if (!confirmDelete()) return;
        await deleteEventById(id, false);
        renderMemberEventView();
    }));
}


function uniqueEventResponses(responses) {
    const byName = new Map();
    responses.forEach((response) => {
        const key = String(response.name || '');
        if (!key) return;
        byName.set(key, response);
    });
    return Array.from(byName.values());
}


function renderGroupedEventResponses(responses) {
    const uniqueResponses = uniqueEventResponses(responses);
    if (!uniqueResponses.length) return '<p class="text-muted">回答はまだありません</p>';
    const groups = ['参加', '不参加'];
    return groups.map((status) => {
        const rows = uniqueResponses.filter((r) => String(r.status || '') === status);
        const body = rows.length
            ? `<div class="list-group">${rows.map((r) => `<div class="list-group-item d-flex justify-content-between align-items-center"><span>${escapeHtml(r.name || '')}</span><span class="badge text-bg-secondary">${escapeHtml(status)}</span></div>`).join('')}</div>`
            : '<p class="text-muted small mb-0">該当者はいません</p>';
        return `<section class="mb-3"><h6>${status}（${rows.length}名）</h6>${body}</section>`;
    }).join('');
}

// 楽曲情報は練習指示と同じく、未開催演奏会の曲一覧から曲別編集へ遷移する。


async function saveOrgMembershipFee() {
    const amount = Number($('orgMembershipFee')?.value || 0);
    const current = currentOrgSetting();
    const name = current.name || current.organization_name || current.organization_name_full || '';
    const shortName = current.short_name || current.shortName || current.organization_abbreviation || '';
    const payload = {
        name,
        organization_name: name,
        organization_abbreviation: shortName,
        short_name: shortName,
        icon_url: current.icon_url || current.iconUrl || '',
        membership_fee_amount: amount
    };
    if (current.id) {
        await request(`/api/extra/org_settings/${encodeURIComponent(current.id)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('org_settings', payload);
    }
    await loadExtraData();
    showAlert('団費を保存しました', 'success');
    renderPaymentAdmin();
}

