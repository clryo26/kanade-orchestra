// Admin database viewer split from modules/admin_system.js.
// Keep global names for legacy non-module loading.

var appState = (typeof window.getAppState === 'function')
    ? window.getAppState()
    : window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

async function renderDatabaseView() {
    const tableSelect = $('databaseTableSelect');
    const pageSizeSelect = $('databasePageSizeSelect');
    const reloadBtn = $('databaseReloadBtn');
    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');

    if (!tableSelect) return;

    if (pageSizeSelect) {
        pageSizeSelect.value = String(appState.databaseLimit || 50);
        pageSizeSelect.onchange = async () => {
            appState.databaseLimit = Number(pageSizeSelect.value || 50) || 50;
            appState.databaseOffset = 0;
            await loadDatabaseRecords();
        };
    }

    tableSelect.onchange = async () => {
        appState.databaseSelectedTable = tableSelect.value || '';
        appState.databaseOffset = 0;
        await loadDatabaseRecords();
    };

    if (reloadBtn) {
        reloadBtn.onclick = () => withButtonStatus(reloadBtn, '更新中...', () => loadDatabaseTablesAndRecords(true));
    }
    if (prevBtn) {
        prevBtn.onclick = async () => {
            appState.databaseOffset = Math.max(0, appState.databaseOffset - appState.databaseLimit);
            await loadDatabaseRecords();
        };
    }
    if (nextBtn) {
        nextBtn.onclick = async () => {
            appState.databaseOffset += appState.databaseLimit;
            await loadDatabaseRecords();
        };
    }

    try {
        await loadDatabaseTablesAndRecords(false);
    } catch (error) {
        const statusEl = $('databaseStatus');
        if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = String(error?.message || 'DB情報の取得に失敗しました');
        }
    }
}

async function loadDatabaseTablesAndRecords(forceReload) {
    const statusEl = $('databaseStatus');
    const tableSelect = $('databaseTableSelect');
    if (!tableSelect) return;

    if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = 'テーブル一覧を読み込み中...';
    }

    const tableUrl = forceReload ? `/api/system/database/tables?_t=${Date.now()}` : '/api/system/database/tables';
    const result = await request(tableUrl);
    appState.databaseTables = Array.isArray(result.tables) ? result.tables : [];

    const previous = appState.databaseSelectedTable;
    const selected = appState.databaseTables.includes(previous)
        ? previous
        : (appState.databaseTables[0] || '');
    appState.databaseSelectedTable = selected;

    tableSelect.innerHTML = appState.databaseTables.length
        ? appState.databaseTables.map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')
        : '<option value="">テーブルがありません</option>';

    if (!selected) {
        if (statusEl) {
            statusEl.textContent = '表示可能なテーブルがありません。';
        }
        clearDatabaseRows();
        return;
    }

    appState.databaseOffset = 0;
    await loadDatabaseRecords(forceReload);
}

function clearDatabaseRows() {
    const head = document.querySelector('#databaseRecordsTable thead');
    const body = document.querySelector('#databaseRecordsTable tbody');
    if (head) head.innerHTML = '';
    if (body) body.innerHTML = '<tr><td class="text-muted">データがありません</td></tr>';
    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
}

async function loadDatabaseRecords(forceReload = false) {
    const statusEl = $('databaseStatus');
    const tableName = appState.databaseSelectedTable;
    if (!tableName) {
        clearDatabaseRows();
        return;
    }

    if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = `テーブル ${tableName} を読み込み中...`;
    }

    const query = new URLSearchParams({
        table: tableName,
        limit: String(appState.databaseLimit),
        offset: String(appState.databaseOffset),
    }).toString();
    const recordUrl = forceReload
        ? `/api/system/database/records?${query}&_t=${Date.now()}`
        : `/api/system/database/records?${query}`;
    const result = await request(recordUrl);

    appState.databaseTotal = Number(result.total || 0);
    renderDatabaseRows(result.columns || [], result.rows || []);

    const from = appState.databaseTotal === 0 ? 0 : appState.databaseOffset + 1;
    const to = Math.min(appState.databaseOffset + appState.databaseLimit, appState.databaseTotal);
    if (statusEl) {
        statusEl.textContent = `${tableName}: ${from}-${to} / ${appState.databaseTotal} 件`;
    }

    const prevBtn = $('databasePrevBtn');
    const nextBtn = $('databaseNextBtn');
    if (prevBtn) prevBtn.disabled = appState.databaseOffset <= 0;
    if (nextBtn) nextBtn.disabled = (appState.databaseOffset + appState.databaseLimit) >= appState.databaseTotal;
}

function formatDatabaseCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function renderDatabaseRows(columns, rows) {
    const head = document.querySelector('#databaseRecordsTable thead');
    const body = document.querySelector('#databaseRecordsTable tbody');
    if (!head || !body) return;

    if (!columns.length) {
        head.innerHTML = '';
        body.innerHTML = '<tr><td class="text-muted">列情報が取得できませんでした</td></tr>';
        return;
    }

    head.innerHTML = `<tr>${columns.map((column) => `<th class="text-nowrap">${escapeHtml(column)}</th>`).join('')}</tr>`;

    if (!rows.length) {
        body.innerHTML = `<tr><td class="text-muted" colspan="${columns.length}">レコードがありません</td></tr>`;
        return;
    }

    body.innerHTML = rows.map((row) => {
        const cells = columns.map((column) => {
            const value = formatDatabaseCell(row[column]);
            return `<td class="small">${escapeHtml(value)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');
}
