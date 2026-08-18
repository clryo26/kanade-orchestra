// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function joinedAtMonthInputValue(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})[-\/\.](\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

function renderConcertRecordView() {
    const container = $('memberConcertRecordInfo');
    if (!container) return;
    const performances = (appState.performances || []).filter((performance) =>
        (appState.concertRecordVideos || []).some((video) => String(video.performance_id || '') === String(performance.id || ''))
    );
    if (!performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会記録はまだ登録されていません</p>';
        return;
    }
    container.innerHTML = performances.map((performance) => {
        const videos = [...(appState.concertRecordVideos || [])]
            .filter((video) => String(video.performance_id || '') === String(performance.id || ''))
            .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id || 0) - Number(b.id || 0));
        return `
            <section class="info-block">
                <h5 class="mb-1">${escapeHtml(performance.title || '演奏会')}</h5>
                <div class="small text-muted mb-3">${escapeHtml(formatDateWithWeekday(performance.date || ''))}</div>
                <div class="row g-3">
                    ${videos.map((video) => `
                        <div class="col-12 col-md-6 col-xl-4">
                            <div class="card h-100">
                                ${video.thumbnail_url
                                    ? `<img src="${escapeHtml(video.thumbnail_url)}" alt="${escapeHtml(video.title || performance.title || 'YouTube動画')}" class="card-img-top" loading="lazy">`
                                    : `<div class="bg-light border-bottom d-flex align-items-center justify-content-center text-muted" style="aspect-ratio: 16 / 9;">サムネイルなし</div>`
                                }
                                <div class="card-body d-flex flex-column">
                                    <h6 class="card-title">${escapeHtml(video.title || performance.title || 'YouTube動画')}</h6>
                                    <div class="mt-auto">
                                        <a class="btn btn-outline-primary btn-lg concert-record-link-button" href="${escapeHtml(video.youtube_url || '')}" target="_blank" rel="noopener noreferrer">視聴する</a>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }).join('');
}

// renderMemberIntros moved to feature module.

async function showOwnProfileEditForm(memberId) {
    const member = memberDetailById(memberId) || memberSummaryById(memberId);
    const container = $('memberIntroInfo');
    if (!member || !container || String(member.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
    await loadMemberDetail(memberId);
    const detail = memberDetailById(memberId) || member;
    const joinedAtMonth = joinedAtMonthInputValue(detail.joined_at);
    container.innerHTML = `
        <div class="card">
            <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                <span>プロフィール編集</span>
                <button class="btn btn-sm btn-outline-secondary" id="profileEditCancelBtn" type="button">戻る</button>
            </div>
            <div class="card-body">
                <div class="row g-3">
                    <div class="col-md-4">
                        <label class="form-label" for="profilePhotoFile">プロフィール写真</label>
                        <input type="file" class="form-control" id="profilePhotoFile" accept="image/*">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" for="profileJoinedAt">入団年月</label>
                        <input type="month" class="form-control" id="profileJoinedAt" value="${escapeHtml(joinedAtMonth)}">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" for="profileIntroducer">紹介者</label>
                        <input type="text" class="form-control" id="profileIntroducer" value="${escapeHtml(detail.introducer || '')}">
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileRole">役割</label>
                        <input type="text" class="form-control" id="profileRole" value="${escapeHtml(detail.role || '')}">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profileInstrumentHistory">楽器歴</label>
                        <textarea class="form-control" id="profileInstrumentHistory" rows="4">${escapeHtml(detail.instrument_history || '')}</textarea>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profilePastOrchestras">過去所属オケ</label>
                        <textarea class="form-control" id="profilePastOrchestras" rows="4">${escapeHtml(detail.past_orchestras || '')}</textarea>
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileComment">コメント</label>
                        <textarea class="form-control" id="profileComment" rows="4">${escapeHtml(detail.comment || '')}</textarea>
                    </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mt-3">
                    <button class="btn btn-primary" id="profileSaveBtn" type="button">保存</button>
                    <button class="btn btn-outline-secondary" id="profileEditCancelBtnBottom" type="button">キャンセル</button>
                </div>
            </div>
        </div>
    `;
    $('profileSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveOwnProfile(detail.id)));
    $('profileEditCancelBtn')?.addEventListener('click', () => void showMemberIntroView());
    $('profileEditCancelBtnBottom')?.addEventListener('click', () => void showMemberIntroView());
}

async function saveOwnProfile(memberId) {
    const current = memberDetailById(memberId) || memberSummaryById(memberId);
    if (!current || String(current.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
    const photoFile = $('profilePhotoFile')?.files?.[0];
    const photoUrl = current.photo_url || '';
    const payload = {
        photo_url: photoUrl,
        joined_at: $('profileJoinedAt')?.value || '',
        introducer: $('profileIntroducer')?.value.trim() || '',
        role: $('profileRole')?.value.trim() || '',
        instrument_history: $('profileInstrumentHistory')?.value.trim() || '',
        past_orchestras: $('profilePastOrchestras')?.value.trim() || '',
        comment: $('profileComment')?.value.trim() || ''
    };
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
        formData.append(key, String(value ?? ''));
    });
    if (photoFile) {
        formData.append('photo_file', photoFile);
    }
    const updatedMember = await request(`/api/members/${encodeURIComponent(memberId)}/profile`, {
        method: 'PUT',
        body: formData,
    });
    if (updatedMember) {
        upsertMemberSummary(updatedMember);
        storeMemberDetailRecord(updatedMember.id, updatedMember, 'loaded');
    }
    renderMembers();
    renderPaymentAdmin();
    renderMemberIntros();
    showAlert('プロフィールを保存しました', 'success');
}

// function renderEvents() moved to modules/events.js.

// function renderPerformances() moved to modules/performances.js.

// renderSchedules moved to feature module.

// renderMemberViews moved to feature module.

// The notice integration wraps setupPortalHome/renderPortalHome. This portal
// view is already loaded before navigation can render the home screen, so it
// is the narrowest place to load the optional integration without growing the
// static initial script bundle.
var portalNoticesModuleLoadPromise = null;

function ensurePortalNoticesModuleLoaded() {
    if (window.__KANADE_PORTAL_NOTICES_MODULE_LOADED__) {
        return Promise.resolve();
    }
    if (portalNoticesModuleLoadPromise) {
        return portalNoticesModuleLoadPromise;
    }

    portalNoticesModuleLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/static/js/modules/notices.js?v=20260812-2';
        script.async = true;
        script.addEventListener('load', function () {
            if (window.__KANADE_PORTAL_NOTICES_MODULE_LOADED__) {
                resolve();
                return;
            }
            portalNoticesModuleLoadPromise = null;
            reject(new Error('Portal notices module loaded but initialization hooks are unavailable'));
        }, { once: true });
        script.addEventListener('error', function () {
            portalNoticesModuleLoadPromise = null;
            reject(new Error('Portal notices module failed to load'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return portalNoticesModuleLoadPromise;
}

function renderPortalHome() {
    if (!window.__KANADE_PORTAL_NOTICES_MODULE_LOADED__) {
        ensurePortalNoticesModuleLoaded()
            .then(function () {
                // notices.js replaces these functions only after its hooks exist.
                setupPortalHome();
                renderPortalHome();
            })
            .catch(function (error) {
                console.warn('[portal-notices] script load failed', error);
            });
        return;
    }
    const announceContainer = $('portalHomeAnnouncements');
    const countdownContainer = $('portalHomeCountdown');
    const menuContainer = $('portalHomeMenu');
    if (!announceContainer || !countdownContainer || !menuContainer) return;

    const announcements = [...(appState.announcements || [])]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, 5);
    announceContainer.innerHTML = announcements.length
        ? '<div class="list-group" id="portalHomeAnnouncementList"></div>'
        : '<p class="text-muted mb-0">お知らせはまだありません</p>';
    const announcementList = $('portalHomeAnnouncementList');
    if (announcementList) {
        announcements.forEach((ann) => {
            announcementList.appendChild(announcementItem(ann, false, { portalHomeOneLine: true }));
        });
    }

    const nextPerf = nextPerformance();
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    const countdownLabel = countdown === 0
        ? '本番当日！頑張りましょう！！'
        : `本番まであと${Math.max(0, countdown)}日！`;
    countdownContainer.innerHTML = nextPerf && countdown !== null
        ? `<section class="portal-countdown-card">
            <div class="portal-countdown-main">${countdownLabel}</div>
            <div class="portal-countdown-sub">${escapeHtml(nextPerf.title || '')} / ${escapeHtml(formatDateWithWeekday(nextPerf.date, ''))}</div>
        </section>`
        : `<section class="portal-countdown-card muted">
            <div class="portal-countdown-main">演奏会情報はまだありません</div>
            <div class="portal-countdown-sub">管理メニューから演奏会情報を登録してください</div>
        </section>`;

    renderMenuGroups(menuContainer);
}

function sortedFlyerDistributionFacilities() {
    return [...(appState.flyerDistributions || [])].sort((a, b) =>
        String(a.facility_name || '').localeCompare(String(b.facility_name || ''), 'ja')
        || String(a.area_address || '').localeCompare(String(b.area_address || ''), 'ja')
    );
}

function sortedPerformancesForFlyerDistribution() {
    return [...(appState.performances || [])]
        .filter((perf) => isUpcomingPerformanceDate(perf.date))
        .sort((a, b) =>
            String(a.date || '').localeCompare(String(b.date || ''))
            || String(a.title || '').localeCompare(String(b.title || ''), 'ja')
        );
}

function flyerDistributionMemberOptionsHtml(selected = '') {
    const current = String(selected || '');
    return ['<option value="">選択してください</option>']
        .concat(sortedMembersByPartAndKana(appState.members || []).map((member) => {
            const id = String(member.id || '');
            const part = member.part ? `（${member.part}）` : '';
            return `<option value="${escapeHtml(id)}" ${id === current ? 'selected' : ''}>${escapeHtml(memberDisplayName(member) + part)}</option>`;
        }))
        .join('');
}

function flyerDistributionMemberName(memberId) {
    const member = (appState.members || []).find((item) => String(item.id || '') === String(memberId || ''));
    return member ? memberDisplayName(member) : '';
}

function findFlyerDistributionAssignment(performanceId, facilityId) {
    return (appState.flyerDistributionAssignments || []).find((item) =>
        String(item.performance_id || '') === String(performanceId || '')
        && String(item.flyer_distribution_id || '') === String(facilityId || '')
    ) || null;
}

function hasDuplicateFlyerDistributionAssignment(performanceId, facilityId, currentAssignmentId = '') {
    const currentId = String(currentAssignmentId || '');
    return (appState.flyerDistributionAssignments || []).some((item) =>
        String(item.performance_id || '') === String(performanceId || '')
        && String(item.flyer_distribution_id || '') === String(facilityId || '')
        && String(item.id || '') !== currentId
    );
}

function renderFlyerDistributionView() {
    const container = $('memberFlyerDistributionInfo');
    if (!container) return;

    const performances = sortedPerformancesForFlyerDistribution();
    const facilities = sortedFlyerDistributionFacilities();

    if (!performances.length) {
        container.innerHTML = '<p class="text-muted mb-0">演奏会情報はまだありません</p>';
        return;
    }
    if (!facilities.length) {
        container.innerHTML = '<p class="text-muted mb-0">チラシ配布先はまだ登録されていません</p>';
        return;
    }

    container.innerHTML = performances.map((performance) => {
        const performanceId = String(performance.id || '');
        return `
            <section class="info-block mb-3">
                <h5 class="mb-2">${escapeHtml(performance.title || '演奏会')}</h5>
                <div class="small text-muted mb-3">${escapeHtml(formatDateWithWeekday(performance.date || '', '日付未設定'))}</div>
                <div class="list-group">${facilities.map((facility) => {
                    const assignment = findFlyerDistributionAssignment(performance.id, facility.id);
                    const facilityId = String(facility.id || '');
                    const distributedMemberId = String(assignment?.distributed_member_id || '');
                    const assignmentNote = String(assignment?.note || '');
                    return `
                        <div class="list-group-item" data-flyer-assignment-row data-performance-id="${escapeHtml(performanceId)}" data-facility-id="${escapeHtml(facilityId)}">
                            <input type="hidden" class="flyer-assignment-id" value="${escapeHtml(String(assignment?.id || ''))}">
                            <div class="fw-bold mb-1">${escapeHtml(facility.facility_name || '')}</div>
                            <div class="small text-muted mb-2">${escapeHtml(facility.area_address || '')}</div>
                            <div class="row g-2 align-items-end">
                                <div class="col-md-6">
                                    <label class="form-label mb-1">配布者</label>
                                    <select class="form-select flyer-distributed-member-id">${flyerDistributionMemberOptionsHtml(distributedMemberId)}</select>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label mb-1">配布日</label>
                                    <input type="date" class="form-control flyer-distributed-date" value="${escapeHtml(String(assignment?.distributed_date || ''))}">
                                </div>
                                <div class="col-12">
                                    <label class="form-label mb-1">備考</label>
                                    <textarea class="form-control flyer-assignment-note multiline-text" rows="3" placeholder="配布登録の備考（任意）">${escapeHtml(assignmentNote)}</textarea>
                                </div>
                            </div>
                            ${String(assignmentNote).trim() ? `<div class="small text-muted mt-2 multiline-text">登録済み備考: ${escapeHtml(assignmentNote)}</div>` : ''}
                            <div class="d-flex flex-wrap gap-2 mt-2">
                                <button class="btn btn-sm btn-success flyer-assignment-save-btn" type="button">保存</button>
                                <button class="btn btn-sm btn-outline-danger flyer-assignment-delete-btn" type="button" ${assignment?.id ? '' : 'disabled'}>削除</button>
                            </div>
                        </div>
                    `;
                }).join('')}</div>
            </section>
        `;
    }).join('');

    container.querySelectorAll('.flyer-assignment-save-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveFlyerDistributionAssignment(event.currentTarget)));
    });
    container.querySelectorAll('.flyer-assignment-delete-btn').forEach((button) => {
        button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteFlyerDistributionAssignment(event.currentTarget)));
    });
}

async function saveFlyerDistributionAssignment(button) {
    const row = button?.closest('[data-flyer-assignment-row]');
    if (!row) return;

    const performanceId = String(row.dataset.performanceId || '');
    const facilityId = String(row.dataset.facilityId || '');
    if (!performanceId || !facilityId) {
        showAlert('配布情報の識別子が不正です', 'warning');
        return;
    }

    const assignmentId = row.querySelector('.flyer-assignment-id')?.value || '';
    const distributedMemberId = row.querySelector('.flyer-distributed-member-id')?.value || '';
    const distributedDate = row.querySelector('.flyer-distributed-date')?.value || '';
    const assignmentNote = row.querySelector('.flyer-assignment-note')?.value || '';

    const payload = {
        performance_id: Number(performanceId),
        flyer_distribution_id: Number(facilityId),
        distributed_member_id: distributedMemberId || '',
        distributed_member_name: flyerDistributionMemberName(distributedMemberId),
        distributed_date: distributedDate,
        note: assignmentNote,
    };

    if (hasDuplicateFlyerDistributionAssignment(performanceId, facilityId, assignmentId)) {
        showAlert('同じ演奏会・配布先の配布情報は1件のみ登録できます。画面を更新して再度お試しください。', 'warning');
        return;
    }

    if (assignmentId) {
        await request(`/api/extra/flyer_distribution_assignments/${encodeURIComponent(assignmentId)}`, jsonOptions('PUT', payload));
    } else {
        await saveExtra('flyer_distribution_assignments', payload);
    }
    await loadExtraData(['flyerDistributionAssignments']);
    renderFlyerDistributionView();
    showAlert('チラシ配布情報を保存しました', 'success');
}

async function deleteFlyerDistributionAssignment(button) {
    const row = button?.closest('[data-flyer-assignment-row]');
    if (!row) return;
    const assignmentId = row.querySelector('.flyer-assignment-id')?.value || '';
    if (!assignmentId) return;
    if (!confirmDelete()) return;
    await request(`/api/extra/flyer_distribution_assignments/${encodeURIComponent(assignmentId)}`, { method: 'DELETE' });
    await loadExtraData(['flyerDistributionAssignments']);
    renderFlyerDistributionView();
    showAlert('チラシ配布情報を削除しました', 'success');
}

function nextPerformance() {
    const upcoming = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= window.portalRuntimeContext.today())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return upcoming[0] || null;
}

// renderMemberPerformances moved to feature module.

function renderManualView() {
    const container = $('memberManualInfo');
    if (!container) return;
    container.innerHTML = `
        <div class="info-block">
            <h5>${escapeHtml(portalTitleText())} の使い方</h5>
            <p class="mb-0">このポータルでは、練習・演奏会・連絡事項・団員向け機能をまとめて確認できます。困ったときはこのマニュアルを開いて基本操作を確認してください。</p>
        </div>
        <div class="info-block">
            <h6>1. メニューの開き方</h6>
            <ul class="mb-0">
                <li>画面左上のメニューボタンからポータルメニューを開きます。</li>
                <li>各カテゴリのボタンを押すと目的の画面に移動できます。</li>
                <li>メニュー下部の「更新」で最新情報を再読み込みできます。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>2. 日常的によく使う機能</h6>
            <ul class="mb-0">
                <li>練習予定: 次回以降の練習日、時間、場所、練習曲を確認します。</li>
                <li>練習予定: 練習日ごとに出席・欠席・遅刻・早退を登録します。</li>
                <li>出欠確認: 練習日ごとの出席・欠席・未登録者を確認します。</li>
                <li>録音部屋: 録音の再生やダウンロードを行います。</li>
                <li>楽譜ライブラリ: 楽譜の表示やダウンロードを行います。</li>
                <li>支払状況: 団費や演奏会費の登録状況を確認します。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>3. 団員向けの登録機能</h6>
            <ul class="mb-0">
                <li>イベント調整: 出欠や回答内容を登録します。</li>
                <li>演奏希望曲: 希望曲の登録や投票ができます。</li>
                <li>宣伝: タイトル・概要・画像付きの宣伝内容を登録できます。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>4. 管理系の機能</h6>
            <ul class="mb-0">
                <li>管理者は管理者メニューから演奏会情報、練習予定、お知らせなどを登録できます。</li>
                <li>録音担当・楽譜担当には専用の管理ボタンが表示されます。</li>
                <li>システム管理者は接続先情報や端末管理などの設定を行えます。</li>
            </ul>
        </div>
        <div class="info-block">
            <h6>5. 困ったとき</h6>
            <ul class="mb-0">
                <li>表示が古い場合は、メニュー下部の「更新」を押してください。</li>
                <li>ログインできない場合は、名前・パート・パスワードを確認してください。</li>
                <li>権限が必要な操作は、管理者またはシステム管理者に依頼してください。</li>
            </ul>
        </div>
    `;
}

// scheduleOptions moved to feature module.

function renderPerformanceFlyerPreview(src) {
    const preview = $('perfFlyerPreview');
    if (!preview) return;
    preview.innerHTML = src ? `<img src="${escapeHtml(src)}" alt="チラシ画像" class="performance-flyer-preview" loading="lazy">` : '';
}

async function previewPerformanceFlyer(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    if ($('perfFlyerImage')) $('perfFlyerImage').value = $('perfFlyerImage').value || '';
    renderPerformanceFlyerPreview(objectUrl);
}
