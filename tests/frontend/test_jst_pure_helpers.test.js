// JST spec R03/R04 (T01-T03): production pure.js / runtime_context.js, evaluated
// in child processes with different device timezones. Not the testable copy.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

const PROBE = `
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.argv[1];
const fixedNow = Number(process.argv[2]);
const RealDate = Date;
class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
}
const sandbox = { console, document: { getElementById: () => null } };
sandbox.window = sandbox;
sandbox.Date = FixedDate;
sandbox.portalCacheState = { dbCache: {}, inFlightGetRequests: new Map() };
sandbox.appState = {};
vm.createContext(sandbox);
for (const file of ['src/static/js/utils/runtime_context.js', 'src/static/js/modules/common_helpers/pure.js', 'src/static/js/modules/payments.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
const r = (code) => vm.runInContext(code, sandbox);
console.log(JSON.stringify({
    labels: [
        r("formatDateTimeLabel('2026-10-19T03:00:00Z')"),
        r("formatDateTimeLabel('2026-10-18T16:00:00Z')"),
        r("formatDateTimeLabel('2026-10-19T01:00:00+09:00')"),
        r("formatDateTimeLabel('2026-10-19T12:00:00.123456+09:00')"),
        r("formatDateWithWeekday('2026-10-19')"),
    ],
    unknown: [r("formatDateTimeLabel('2026-10-19T03:00:00')"), r("formatDateTimeLabel('garbage')"), r("formatDateTimeLabel('')"), r("formatDateWithWeekday('2026/10/19')"), r("formatDateWithWeekday('', '未設定')")],
    today: r("portalRuntimeContext.today()"),
    daysUntil: [r("daysUntil('2026-11-02')"), r("daysUntil('2026-03-09')"), r("daysUntil('bad')")],
    nextDay: [r("nextAllDayDate('2026-03-08')"), r("nextAllDayDate('2026-11-01')"), r("nextAllDayDate('2028-02-28')"), r("nextAllDayDate('2026-12-31')")],
    addHours: [r("addHoursToTime('23:30', 1)"), r("addHoursToTime('01:00', -2)"), r("addHoursToTime('9:15', 3)")],
    validDate: [r("isValidPerformanceDate('2028-02-29')"), r("isValidPerformanceDate('2027-02-29')")],
    boundary: [r("portalJstDateBoundaryIso('2026-10-19')"), r("portalJstDateBoundaryIso('2026-12-31', true)"), r("portalJstDateBoundaryIso('2026-13-01')")],
    sorted: r("[{id:1,created_at:'2026-10-19T09:00:00+09:00'},{id:2,created_at:'2026-10-19T01:00:00Z'},{id:3,created_at:'bad'},{id:4,created_at:'2026-10-19T00:30:00Z'}].sort(comparePortalInstantDesc).map((x) => x.id)"),
    instantMs: r("parsePortalInstantMs('2026-10-19T12:00:00.123456+09:00')"),
    microSorted: r("[{id:2,created_at:'2026-10-19T03:00:00.123001Z'},{id:1,created_at:'2026-10-19T12:00:00.123002+09:00'}].sort(comparePortalInstantDesc).map((x) => x.id)"),
    invalidOffset: r("Number.isNaN(parsePortalInstantMs('2026-10-19T12:00:00+09:99'))"),
    monthOverflow: r("addMonths('2026-01-31', 1).toISOString().slice(0, 10)"),
}));
`;

function probe(tz, nowIso) {
    const out = execFileSync(process.execPath, ['-e', PROBE, ROOT, String(Date.parse(nowIso))], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
    });
    return JSON.parse(out);
}

describe.each(['Asia/Tokyo', 'UTC', 'America/New_York'])('JST helpers with device TZ=%s', (tz) => {
    // 2026-10-19 00:30 JST == 2026-10-18 15:30 UTC (a UTC device is still on the 18th).
    const result = probe(tz, '2026-10-18T15:30:00Z');

    test('the spec R03 table renders the same JST date, weekday and time', () => {
        expect(result.labels).toEqual([
            '2026/10/19（月） 12:00',
            '2026/10/19（月） 01:00',
            '2026/10/19（月） 01:00',
            '2026/10/19（月） 12:00',
            '2026/10/19（月）',
        ]);
    });

    test('offset-less, invalid and empty values are not guessed', () => {
        expect(result.unknown).toEqual(['日時不明', '日時不明', '未記録', '日付不明', '未設定']);
    });

    test('today is the Japan calendar day', () => {
        expect(result.today).toBe('2026-10-19');
    });

    test('calendar arithmetic ignores device DST', () => {
        // 2026-11-01 (US DST end) and 2026-03-08 (US DST start) are inside these spans.
        expect(result.daysUntil).toEqual([14, -224, null]);
        expect(result.nextDay).toEqual(['2026-03-09', '2026-11-02', '2028-02-29', '2027-01-01']);
        expect(result.addHours).toEqual(['00:30', '23:00', '12:15']);
        expect(result.validDate).toEqual([true, false]);
        expect(result.monthOverflow).toBe('2026-03-03');
    });

    test('search boundaries are JST day starts with an exclusive end', () => {
        expect(result.boundary).toEqual(['2026-10-19T00:00:00+09:00', '2027-01-01T00:00:00+09:00', '']);
    });

    test('instants sort as instants, unknown last', () => {
        // id1 09:00+09:00 = 00:00Z < id4 00:30Z < id2 01:00Z
        expect(result.sorted).toEqual([2, 4, 1, 3]);
        expect(result.instantMs).toBe(Date.parse('2026-10-19T03:00:00.123Z'));
        expect(result.microSorted).toEqual([1, 2]);
        expect(result.invalidOffset).toBe(true);
    });
});

test('the date changes at 00:00 JST, not at the device midnight', () => {
    expect(probe('UTC', '2026-10-18T14:59:59Z').today).toBe('2026-10-18');
    expect(probe('UTC', '2026-10-18T15:00:00Z').today).toBe('2026-10-19');
    expect(probe('America/New_York', '2026-12-31T15:00:00Z').today).toBe('2027-01-01');
});
