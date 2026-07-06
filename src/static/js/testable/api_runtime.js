function apiActionLabel(method) {
    const upper = String(method || 'GET').toUpperCase();
    if (upper === 'POST') return '登録';
    if (upper === 'PUT' || upper === 'PATCH') return '更新';
    if (upper === 'DELETE') return '削除';
    return '取得';
}

function apiTargetLabel(url) {
    const path = String(url || '').split('?')[0];
    const extra = path.match(/^\/api\/extra\/([^\/]+)/);
    if (extra) {
        const labels = {
            performance_day_infos: '本番情報',
            piece_infos: '曲別情報',
            practice_instructions: '練習指示',
            part_settings: 'パート設定',
            venue_settings: '会場設定',
            flyer_distributions: 'チラシ配布管理',
            flyer_distribution_assignments: 'チラシ配布情報',
            org_settings: '団体設定',
            sns_settings: 'SNS設定',
            connection_settings: '接続設定',
            desired_pieces: '希望曲',
            promotions: '宣伝情報',
            albums: 'アルバム',
        };
        return labels[extra[1]] || extra[1];
    }
    if (path.startsWith('/api/auth/')) return '認証情報';
    if (path.startsWith('/api/bootstrap')) return '初期データ';
    if (path.startsWith('/api/performances')) return '本番一覧';
    if (path.startsWith('/api/schedules')) return '練習予定';
    return 'データ';
}

function buildApiFailureMessage(url, method, status, detail) {
    if (status === 401) {
        return 'ログイン期限が切れました。再ログインしてください。';
    }
    if (status === 0) {
        return '通信が切断されました。再接続しています... [再試行]';
    }
    const action = apiActionLabel(method);
    const target = apiTargetLabel(url);
    const reason = String(detail || '').trim();
    if (reason) {
        return `${target}の${action}に失敗しました。原因: ${reason}`;
    }
    return `${target}の${action}に失敗しました。時間をおいて再試行してください。`;
}

function shouldAttemptAuthRecovery(status, options, url) {
    const skip = Boolean(options && options._skipAuthRecovery);
    if (skip) return false;
    if (Number(status) !== 401) return false;
    const path = String(url || '').split('?')[0];
    if (path === '/api/auth/portal-login') return false;
    return true;
}

module.exports = {
    apiActionLabel,
    apiTargetLabel,
    buildApiFailureMessage,
    shouldAttemptAuthRecovery,
};
