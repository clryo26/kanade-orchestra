// Venue dropdowns of the performance / schedule registration forms.
// Runs the real candidate builder (admin_system/helpers.js), the real
// escapeHtml (common_helpers/pure.js) and the real tab loader
// (bootstrap_loader.js) in one context, with a minimal <select> stand-in.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const PURE_SOURCE = read('src/static/js/modules/common_helpers/pure.js');
const HELPERS_SOURCE = read('src/static/js/modules/admin_system/helpers.js');
const LOADER_SOURCE = read('src/static/js/modules/bootstrap_loader.js');

const unescapeHtml = (value) => String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&');

// A single-choice <select>: the last `selected` option wins, otherwise the
// first one; assigning an unknown value clears the selection as browsers do.
function createSelect() {
    const select = { options: [], _html: '', _value: '' };
    Object.defineProperty(select, 'innerHTML', {
        get() { return select._html; },
        set(html) {
            select._html = html;
            select.options = [...html.matchAll(/<option value="([^"]*)"\s*(selected)?\s*>([^<]*)<\/option>/g)]
                .map((match) => ({ value: unescapeHtml(match[1]), selected: Boolean(match[2]), text: unescapeHtml(match[3]) }));
            const chosen = select.options.filter((option) => option.selected).pop() || select.options[0];
            select._value = chosen ? chosen.value : '';
        },
    });
    Object.defineProperty(select, 'value', {
        get() { return select._value; },
        set(value) {
            select._value = select.options.some((option) => option.value === value) ? value : '';
        },
    });
    return select;
}

const selectedText = (select) => select.options.find((option) => option.value === select.value)?.text;

function createVenueSandbox() {
    const elements = {
        perfVenue: createSelect(),
        schedVenue: createSelect(),
        perfTitle: { value: '' },
        perfDate: { value: '' },
        perfOpenTime: { value: '' },
        perfStartTime: { value: '' },
        perfConductor: { value: '' },
        schedDate: { value: '' },
        schedStartTime: { value: '' },
        schedEndTime: { value: '' },
        schedNotes: { value: '' },
    };
    const appState = { venueSettings: [] };
    const request = vi.fn(async () => []);
    const sandbox = {
        console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
        document: { addEventListener: vi.fn() },
        request,
        requestJson: vi.fn(),
        showAlert: vi.fn(),
        setLoadingBar: vi.fn(),
        clearLoadingBar: vi.fn(),
        renderMemberExtraViews: vi.fn(),
        renderVenueManagement: vi.fn(),
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.portalRuntimeContext = {
        appState,
        getById: (id) => elements[id] || null,
        dbCache: { getEntry: vi.fn(), delete: vi.fn() },
    };
    vm.createContext(sandbox);
    // Same order as the production loader: helpers before the bootstrap loader.
    vm.runInContext(PURE_SOURCE, sandbox);
    vm.runInContext(HELPERS_SOURCE, sandbox);
    vm.runInContext(LOADER_SOURCE, sandbox);
    return { sandbox, appState, elements, request };
}

// Hiragana names keep the expected Japanese collation order unambiguous.
const VENUES = [
    { id: 1, name: 'たちばな会館', for_performance: true, for_practice: true },
    { id: 2, name: 'さくらホール', for_performance: true, for_practice: false },
    { id: 3, name: 'かもめ会館' }, // legacy row without usage flags
    { id: 4, name: 'あおば練習場', for_performance: false, for_practice: true },
];

describe('venue select candidates', () => {
    test('filters by usage, keeps legacy rows without flags, sorts by name and starts with the placeholder', () => {
        const { sandbox, appState } = createVenueSandbox();
        appState.venueSettings = VENUES;

        const performance = createSelect();
        performance.innerHTML = sandbox.venueSelectOptionsHtml('performance', '');
        expect(performance.options.map((option) => option.value)).toEqual(['', 'かもめ会館', 'さくらホール', 'たちばな会館']);
        expect(performance.options[0].text).toBe('選択してください');
        expect(performance.value).toBe('');

        const practice = createSelect();
        practice.innerHTML = sandbox.venueSelectOptionsHtml('practice', '');
        expect(practice.options.map((option) => option.value)).toEqual(['', 'あおば練習場', 'かもめ会館', 'たちばな会館']);
        expect(practice.options[0].text).toBe('選択してください');
    });

    test('keeps a registered selection without adding an unregistered option', () => {
        const { sandbox, appState } = createVenueSandbox();
        appState.venueSettings = VENUES;
        const select = createSelect();
        select.innerHTML = sandbox.venueSelectOptionsHtml('practice', 'かもめ会館');
        expect(select.value).toBe('かもめ会館');
        expect(selectedText(select)).toBe('かもめ会館');
        expect(select.innerHTML).not.toContain('（未登録会場）');
    });

    test.each([
        ['practice', 'さくらホール'], // registered, but for performances only
        ['performance', 'あおば練習場'], // registered, but for practice only
        ['performance', '旧会場'], // not registered at all
    ])('%s keeps a saved venue %s that is not a candidate as an unregistered option', (kind, saved) => {
        const { sandbox, appState } = createVenueSandbox();
        appState.venueSettings = VENUES;
        const select = createSelect();
        select.innerHTML = sandbox.venueSelectOptionsHtml(kind, saved);
        expect(select.value).toBe(saved);
        expect(selectedText(select)).toBe(`${saved}（未登録会場）`);
        expect(select.options.filter((option) => option.value === saved)).toHaveLength(1);
    });

    test('escapes venue names in both the value and the label', () => {
        const { sandbox, appState } = createVenueSandbox();
        const hostile = '<img src=x onerror=alert(1)>"&\'';
        appState.venueSettings = [{ id: 1, name: hostile }];

        const html = sandbox.venueSelectOptionsHtml('performance', hostile);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#039;');
        const select = createSelect();
        select.innerHTML = html;
        expect(select.value).toBe(hostile);
        expect(selectedText(select)).toBe(hostile);

        const unregistered = sandbox.venueSelectOptionsHtml('practice', '<b>x</b>');
        expect(unregistered).not.toContain('<b>');
        expect(unregistered).toContain('&lt;b&gt;x&lt;/b&gt;（未登録会場）');
    });
});

describe('venue load from the registration tabs', () => {
    test('a venue load fills both dropdowns from the real refresh path', async () => {
        const { sandbox, elements, request } = createVenueSandbox();
        // The forms start with only the placeholder because the lite bootstrap has no venues.
        elements.perfVenue.innerHTML = sandbox.venueSelectOptionsHtml('performance', '');
        elements.schedVenue.innerHTML = sandbox.venueSelectOptionsHtml('practice', '');
        expect(elements.perfVenue.options).toHaveLength(1);
        request.mockImplementation(async () => VENUES);

        await sandbox.ensureDeferredTabDataLoaded('performance');

        expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/extra/venue_settings']);
        expect(elements.perfVenue.options.map((option) => option.value)).toEqual(['', 'かもめ会館', 'さくらホール', 'たちばな会館']);
        expect(elements.schedVenue.options.map((option) => option.value)).toEqual(['', 'あおば練習場', 'かもめ会館', 'たちばな会館']);
        // A loaded candidate can be chosen.
        elements.perfVenue.value = 'さくらホール';
        expect(elements.perfVenue.value).toBe('さくらホール');
        elements.schedVenue.value = 'あおば練習場';
        expect(elements.schedVenue.value).toBe('あおば練習場');
    });

    test('a venue load during editing keeps selections and other inputs, and drops the unregistered label for matching venues', async () => {
        const { sandbox, elements, request } = createVenueSandbox();
        // Editing opened before the load finished: saved venues are only supplements.
        elements.perfVenue.innerHTML = sandbox.venueSelectOptionsHtml('performance', 'さくらホール');
        elements.schedVenue.innerHTML = sandbox.venueSelectOptionsHtml('practice', 'あおば練習場');
        expect(selectedText(elements.perfVenue)).toBe('さくらホール（未登録会場）');
        expect(selectedText(elements.schedVenue)).toBe('あおば練習場（未登録会場）');
        const typed = {
            perfTitle: '秋の定期演奏会', perfDate: '2099-10-01', perfOpenTime: '17:30',
            perfStartTime: '18:00', perfConductor: '指揮者A', schedDate: '2099-09-15',
            schedStartTime: '09:30', schedEndTime: '12:00', schedNotes: '分奏あり',
        };
        Object.entries(typed).forEach(([id, value]) => { elements[id].value = value; });
        request.mockImplementation(async () => VENUES);

        await sandbox.ensureDeferredTabDataLoaded('schedule');

        expect(elements.perfVenue.value).toBe('さくらホール');
        expect(selectedText(elements.perfVenue)).toBe('さくらホール');
        expect(elements.schedVenue.value).toBe('あおば練習場');
        expect(selectedText(elements.schedVenue)).toBe('あおば練習場');
        expect(elements.perfVenue.innerHTML).not.toContain('（未登録会場）');
        expect(elements.schedVenue.innerHTML).not.toContain('（未登録会場）');
        Object.entries(typed).forEach(([id, value]) => { expect(elements[id].value).toBe(value); });
    });

    test('a saved venue without a matching registered venue keeps its unregistered option after the load', async () => {
        const { sandbox, elements, request } = createVenueSandbox();
        elements.perfVenue.innerHTML = sandbox.venueSelectOptionsHtml('performance', '旧会場');
        // Registered for performances only, so it does not match the practice form.
        elements.schedVenue.innerHTML = sandbox.venueSelectOptionsHtml('practice', 'さくらホール');
        request.mockImplementation(async () => VENUES);

        await sandbox.ensureDeferredTabDataLoaded('performance');

        expect(elements.perfVenue.value).toBe('旧会場');
        expect(selectedText(elements.perfVenue)).toBe('旧会場（未登録会場）');
        expect(elements.schedVenue.value).toBe('さくらホール');
        expect(selectedText(elements.schedVenue)).toBe('さくらホール（未登録会場）');
    });

    test('an empty venue response adds no candidates and keeps the current selection', async () => {
        const { sandbox, elements, request } = createVenueSandbox();
        elements.perfVenue.innerHTML = sandbox.venueSelectOptionsHtml('performance', '');
        elements.schedVenue.innerHTML = sandbox.venueSelectOptionsHtml('practice', '旧練習場');
        request.mockImplementation(async () => []);

        await sandbox.ensureDeferredTabDataLoaded('performance');

        expect(elements.perfVenue.options.map((option) => option.value)).toEqual(['']);
        expect(elements.schedVenue.options.map((option) => option.value)).toEqual(['', '旧練習場']);
        expect(selectedText(elements.schedVenue)).toBe('旧練習場（未登録会場）');
    });

    test('a failed venue load keeps the dropdowns, and the next registration tab fills them', async () => {
        const { sandbox, appState, elements, request } = createVenueSandbox();
        elements.perfVenue.innerHTML = sandbox.venueSelectOptionsHtml('performance', 'さくらホール');
        elements.perfTitle.value = '入力途中のタイトル';
        request
            .mockImplementationOnce(async () => { throw new Error('offline'); })
            .mockImplementation(async () => VENUES);

        await sandbox.ensureDeferredTabDataLoaded('performance');
        expect(sandbox.showAlert).toHaveBeenCalledWith(expect.stringContaining('venueSettings'), 'warning');
        expect(appState.venueSettings).toEqual([]);
        expect(selectedText(elements.perfVenue)).toBe('さくらホール（未登録会場）');

        await sandbox.ensureDeferredTabDataLoaded('schedule');
        expect(request).toHaveBeenCalledTimes(2);
        expect(elements.perfVenue.value).toBe('さくらホール');
        expect(selectedText(elements.perfVenue)).toBe('さくらホール');
        expect(elements.schedVenue.options.map((option) => option.value)).toEqual(['', 'あおば練習場', 'かもめ会館', 'たちばな会館']);
        expect(elements.perfTitle.value).toBe('入力途中のタイトル');
    });
});
