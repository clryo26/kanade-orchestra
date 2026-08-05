// Frontend split: extracted from main.js.
// Loaded after main.js; functions intentionally remain global for legacy handlers.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function bindUpload() {
    const fileInput = $('fileInput');

    $('selectFileBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => handleFiles(event.target.files));
    if ($('memberIntroTopBtn')) $('memberIntroTopBtn').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    $('uploadDate').addEventListener('input', updateSavePath);
    if ($('uploadPerformance')) $('uploadPerformance').addEventListener('change', () => renderUploadPieceOptions());
    $('uploadPiece').addEventListener('change', updateSavePath);
    $('uploadBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => uploadToLocalStore()));
    $('clearBtn').addEventListener('click', clearUploadForm);
}

// 管理画面の各フォーム操作イベントをまとめて設定する。

function bindForms() {
    $('addPerfBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePerformance()));
    $('editPerfBtn').addEventListener('click', clearPerformanceForm);
    $('deletePerfBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePerformance()));
    $('addPieceBtn').addEventListener('click', addPerformancePiece);
    if ($('perfFlyerFile')) $('perfFlyerFile').addEventListener('change', previewPerformanceFlyer);
    if ($('savePerformanceDayInfoBtn')) $('savePerformanceDayInfoBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePerformanceDayInfo()));
    if ($('exportPerformanceDayInfoExcelBtn')) $('exportPerformanceDayInfoExcelBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '出力中...', () => exportPerformanceDayInfoExcel()));
    if ($('clearPerformanceDayInfoBtn')) $('clearPerformanceDayInfoBtn').addEventListener('click', () => clearPerformanceDayInfoForm());
    if ($('deletePerformanceDayInfoBtn')) $('deletePerformanceDayInfoBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePerformanceDayInfo()));
    if ($('addPerformanceDayAssignmentRowBtn')) $('addPerformanceDayAssignmentRowBtn').addEventListener('click', addPerformanceDayAssignmentRow);
    if ($('performanceDayInfoPerformance')) $('performanceDayInfoPerformance').addEventListener('change', () => {
        $('performanceDayInfoId').value = '';
        if (typeof renderPerformanceDayPartRehearsalRows === 'function') renderPerformanceDayPartRehearsalRows();
    });
    if ($('performanceDayAssignmentRows')) renderPerformanceDayAssignmentRows([]);
    if ($('savePracticeInstructionBtn')) $('savePracticeInstructionBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePracticeInstructionAdmin()));
    if ($('clearPracticeInstructionBtn')) $('clearPracticeInstructionBtn').addEventListener('click', clearPracticeInstructionForm);
    if ($('deletePracticeInstructionBtn')) $('deletePracticeInstructionBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deletePracticeInstructionAdmin()));
    if ($('practiceInstructionPerformance')) $('practiceInstructionPerformance').addEventListener('change', updatePracticeInstructionPieceOptions);

    $('addSchedBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSchedule()));
    $('editSchedBtn').addEventListener('click', clearScheduleForm);
    $('deleteSchedBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSchedule()));
    $('schedPerformance').addEventListener('change', () => updateSchedulePieceOptions());

    $('addAnnBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveAnnouncement()));
    $('editAnnBtn').addEventListener('click', clearAnnouncementForm);
    $('deleteAnnBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteAnnouncement()));

    $('addEventBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveEvent()));
    $('clearEventBtn').addEventListener('click', clearEventForm);
    $('deleteEventBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteEvent()));

    $('addMemberBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveMember()));
    $('resetMemberPasswordBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, 'リセット中...', () => resetMemberPassword()));
    $('clearMemberBtn').addEventListener('click', clearMemberForm);
    $('deleteMemberBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteMember()));
    if ($('memberPermission')) $('memberPermission').addEventListener('change', syncMemberPermissionFields);
    syncMemberPermissionFields();

    if ($('paymentMemberId')) $('paymentMemberId').addEventListener('change', () => selectPaymentByMember($('paymentMemberId').value));
    if ($('savePaymentBtn')) $('savePaymentBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePaymentStatus()));
    if ($('clearPaymentBtn')) $('clearPaymentBtn').addEventListener('click', clearPaymentForm);

    if ($('savePartSettingBtn')) $('savePartSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => savePartSetting()));
    if ($('clearPartSettingBtn')) $('clearPartSettingBtn').addEventListener('click', clearPartSettingForm);
    document.querySelectorAll('.venue-save-by-type-btn').forEach((button) => button.addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveVenueSetting(button.dataset.venueType || 'practice'))));
    document.querySelectorAll('.venue-clear-by-type-btn').forEach((button) => button.addEventListener('click', () => clearVenueSettingForm(button.dataset.venueType || 'practice')));
    if ($('saveFlyerDistributionBtn')) $('saveFlyerDistributionBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveFlyerDistributionSetting()));
    if ($('deleteFlyerDistributionBtn')) $('deleteFlyerDistributionBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '削除中...', () => deleteSelectedFlyerDistributionSetting()));
    if ($('clearFlyerDistributionBtn')) $('clearFlyerDistributionBtn').addEventListener('click', clearFlyerDistributionForm);
    if ($('saveVenueSettingBtn')) $('saveVenueSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveVenueSetting($('venueUsageType')?.value || 'practice')));
    if ($('clearVenueSettingBtn')) $('clearVenueSettingBtn').addEventListener('click', () => clearVenueSettingForm());
    if ($('saveOrgSettingBtn')) $('saveOrgSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveOrgSetting()));
    if ($('clearOrgSettingBtn')) $('clearOrgSettingBtn').addEventListener('click', clearOrgSettingForm);
    if ($('orgIconFile')) $('orgIconFile').addEventListener('change', previewOrgIcon);
    if ($('saveSnsSettingBtn')) $('saveSnsSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveSnsSetting()));
    if ($('clearSnsSettingBtn')) $('clearSnsSettingBtn').addEventListener('click', clearSnsSettingForm);
    if ($('saveConnectionSettingBtn')) $('saveConnectionSettingBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '保存中...', () => saveConnectionSetting()));
    if ($('clearConnectionSettingBtn')) $('clearConnectionSettingBtn').addEventListener('click', clearConnectionSettingForm);
    if ($('accessLogReloadBtn')) $('accessLogReloadBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '読込中...', () => renderAccessLogView()));

    if ($('sheetPerformanceSelect')) $('sheetPerformanceSelect').addEventListener('change', updateSheetPieceOptions);
    if ($('uploadSheetBtn')) $('uploadSheetBtn').addEventListener('click', (event) => withButtonStatus(event.currentTarget, '登録中...', () => uploadSheets()));
    
    bindCastingAdminEvents();
}

// 管理者パネル表示要求のガード処理。
// 認証状態と権限を確認してからパネルを開く。

function handleFiles(files) {
    const selected = Array.from(files || []);
    if (!selected.length) return;

    const validFiles = selected.filter((file) => {
        const extension = file.name.split('.').pop().toLowerCase();
        return ['mp3', 'm4a'].includes(extension);
    });
    if (validFiles.length !== selected.length) {
        showAlert('MP3 または M4A ファイルを選択してください', 'warning');
    }
    if (!validFiles.length) return;

    appState.selectedFiles = validFiles;
    $('selectedFileName').textContent = selectedFileSummary(validFiles);
    showAlert(`${validFiles.length} 件のファイルを選択しました`, 'success');
}

// 選択済み録音ファイルを順次アップロードする。
// 進捗表示を更新しながら失敗時は途中件数を通知する。

async function uploadToLocalStore() {
    if (!appState.selectedFiles.length) {
        showAlert('先にファイルを選択してください', 'warning');
        return;
    }
    if (!$('uploadPerformance')?.value || !$('uploadPiece')?.value) {
        showAlert('演奏会と曲名を選択してください', 'warning');
        return;
    }

    setOperationStatus('uploadProgress', `録音ファイルを保存しています。0 / ${appState.selectedFiles.length} 件`);
    let completed = 0;
    try {
        for (const file of appState.selectedFiles) {
            setOperationStatus('uploadProgress', `保存中: ${file.name}（${completed + 1} / ${appState.selectedFiles.length} 件）`);
            await request('/api/drive/upload', { method: 'POST', body: audioFormData(file) });
            completed += 1;
            setOperationStatus('uploadProgress', `保存完了: ${completed} / ${appState.selectedFiles.length} 件`);
        }
        showAlert(`${completed} 件の録音ファイルを保存しました`, 'info');
        await loadRecordings();
        setOperationStatus('uploadProgress', `保存が完了しました。${completed} 件の録音ファイルを一覧に反映しました。`);
    } catch (error) {
        setOperationStatus('uploadProgress', `保存に失敗しました。${completed} / ${appState.selectedFiles.length} 件まで完了しています。`, 'danger');
        throw error;
    }
}

// 録音アップロード API 用 FormData を組み立てる。

function audioFormData(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('date', document.getElementById('uploadDate').value);
    formData.append('piece', document.getElementById('uploadPiece').value.trim());
    return formData;
}

function selectedFileSummary(files) {
    if (files.length === 1) {
        const file = files[0];
        return `${file.name} (${formatBytes(file.size)})`;
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    return `${files.length} 件選択 (${formatBytes(totalSize)})`;
}

function clearUploadForm() {
    appState.selectedFiles = [];
    $('fileInput').value = '';
    $('selectedFileName').textContent = '未選択';
    $('uploadDate').value = window.portalRuntimeContext.today();
    if ($('uploadPerformance')) $('uploadPerformance').value = '';
    $('uploadPiece').value = '';
    renderUploadPieceOptions();
    const progress = $('uploadProgress');
    if (progress) progress.hidden = true;
    updateSavePath();
}

// 初回表示に必要な最小データだけを先に取得する。
// 演奏会・練習予定・お知らせなど、ホーム表示に直結する内容を優先する。
