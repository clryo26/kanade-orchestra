// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

function renderConcertRecordView() {
    const container = $('memberConcertRecordInfo');
    if (!container) return;
    const youtubeUrl = currentSnsSetting().youtube_url || '';
    container.innerHTML = youtubeUrl
        ? `<a class="btn btn-outline-primary btn-lg sns-link-button" href="${escapeHtml(youtubeUrl)}" target="_blank" rel="noopener noreferrer">YouTube</a>`
        : '<p class="text-muted mb-0">YouTubeリンクはまだ登録されていません</p>';
}

// renderMemberIntros moved to feature module.

function showOwnProfileEditForm(memberId) {
    const member = appState.members.find((item) => String(item.id || '') === String(memberId));
    const container = $('memberIntroInfo');
    if (!member || !container || String(member.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
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
                        <input type="month" class="form-control" id="profileJoinedAt" value="${escapeHtml(member.joined_at || '')}">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" for="profileIntroducer">紹介者</label>
                        <input type="text" class="form-control" id="profileIntroducer" value="${escapeHtml(member.introducer || '')}">
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileRole">役割</label>
                        <input type="text" class="form-control" id="profileRole" value="${escapeHtml(member.role || '')}">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profileInstrumentHistory">楽器歴</label>
                        <textarea class="form-control" id="profileInstrumentHistory" rows="4">${escapeHtml(member.instrument_history || '')}</textarea>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" for="profilePastOrchestras">過去所属オケ</label>
                        <textarea class="form-control" id="profilePastOrchestras" rows="4">${escapeHtml(member.past_orchestras || '')}</textarea>
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="profileComment">コメント</label>
                        <textarea class="form-control" id="profileComment" rows="4">${escapeHtml(member.comment || '')}</textarea>
                    </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mt-3">
                    <button class="btn btn-primary" id="profileSaveBtn" type="button">保存</button>
                    <button class="btn btn-outline-secondary" id="profileEditCancelBtnBottom" type="button">キャンセル</button>
                </div>
            </div>
        </div>
    `;
    $('profileSaveBtn')?.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveOwnProfile(member.id)));
    $('profileEditCancelBtn')?.addEventListener('click', renderMemberIntros);
    $('profileEditCancelBtnBottom')?.addEventListener('click', renderMemberIntros);
}

async function saveOwnProfile(memberId) {
    const current = appState.members.find((item) => String(item.id || '') === String(memberId));
    if (!current || String(current.id || '') !== String(appState.currentUserMemberId || '')) {
        showAlert('編集できるプロフィールが見つかりません', 'warning');
        return;
    }
    const photoFile = $('profilePhotoFile')?.files?.[0];
    const photoUrl = photoFile ? await fileToDataUrl(photoFile) : (current.photo_url || '');
    const payload = {
        ...current,
        photo_url: photoUrl,
        joined_at: $('profileJoinedAt')?.value || '',
        introducer: $('profileIntroducer')?.value.trim() || '',
        role: $('profileRole')?.value.trim() || '',
        instrument_history: $('profileInstrumentHistory')?.value.trim() || '',
        past_orchestras: $('profilePastOrchestras')?.value.trim() || '',
        comment: $('profileComment')?.value.trim() || ''
    };
    await request(`/api/members/${encodeURIComponent(memberId)}`, jsonOptions('PUT', payload));
    await loadMembers();
    showAlert('プロフィールを保存しました', 'success');
}

// function renderEvents() moved to modules/events.js.

// function renderPerformances() moved to modules/performances.js.

// renderSchedules moved to feature module.

// renderMemberViews moved to feature module.

function renderPortalHome() {
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
            announcementList.appendChild(announcementItem(ann, false));
        });
    }

    const nextPerf = nextPerformance();
    const countdown = nextPerf ? daysUntil(nextPerf.date) : null;
    countdownContainer.innerHTML = nextPerf && countdown !== null
        ? `<section class="portal-countdown-card">
            <div class="portal-countdown-main">本番まであと${Math.max(0, countdown)}日！</div>
            <div class="portal-countdown-sub">${escapeHtml(nextPerf.title || '')} / ${escapeHtml(formatDateWithWeekday(nextPerf.date, ''))}</div>
        </section>`
        : `<section class="portal-countdown-card muted">
            <div class="portal-countdown-main">演奏会情報はまだありません</div>
            <div class="portal-countdown-sub">管理メニューから演奏会情報を登録してください</div>
        </section>`;

    renderMenuGroups(menuContainer);
}

function nextPerformance() {
    const upcoming = [...(appState.performances || [])]
        .filter((perf) => perf.date && perf.date >= today())
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
                <li>欠席連絡: 欠席・遅刻・早退を登録します。</li>
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
    const dataUrl = await fileToDataUrl(file);
    if ($('perfFlyerImage')) $('perfFlyerImage').value = dataUrl;
    renderPerformanceFlyerPreview(dataUrl);
}
