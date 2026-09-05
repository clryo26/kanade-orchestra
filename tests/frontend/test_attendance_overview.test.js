const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/absences.js'), 'utf8');

function sandbox() {
  const appState = { schedules: [], absences: [], members: [], partSettings: [], attendanceOverviewSelectionBySchedule: {} };
  const context = { appState, Set, Map, console, window: null, globalThis: null, document: {}, currentUserMemberName: () => '', sortedSchedules: (items) => [...items], memberDisplayName: (member) => member.name, memberKanaName: (member) => member.kana || member.name, partSortIndex: (part) => ({ Violin: 1, Viola: 2, Cello: 3 }[part] || 99), groupBy: (items, key) => items.reduce((groups, item) => { (groups[item[key]] ||= []).push(item); return groups; }, {}), escapeHtml: (value) => String(value), formatScheduleDate: (value) => value, scheduleTimeLabel: () => '', $: () => null };
  context.window = context; context.globalThis = context;
  context.portalRuntimeContext = { appState, today: () => '2026-08-18', getById: () => null };
  vm.runInNewContext(`${SOURCE}\nglobalThis.attendanceTestApi = { visibleAttendanceSchedules, attendanceOverviewHtml };`, context);
  return { appState, api: context.attendanceTestApi };
}

test('overview excludes past practices and groups selected entries by part then name', () => {
  const { appState, api } = sandbox();
  appState.schedules = [{ id: 1, date: '2026-08-17' }, { id: 2, date: '2026-08-18' }];
  expect(api.visibleAttendanceSchedules().map((item) => item.id)).toEqual([2]);
  appState.members = [{ id: 1, name: 'いち', kana: 'いち', part: 'Viola' }, { id: 2, name: 'あ', kana: 'あ', part: 'Violin' }, { id: 3, name: 'え', kana: 'え', part: 'Violin' }];
  appState.absences = [{ schedule_id: 2, member_id: 1, name: 'いち', status: 'late', planned_time: '14:00' }, { schedule_id: 2, member_id: 2, name: 'あ', status: 'present' }];
  const html = api.attendanceOverviewHtml({ id: 2, date: '2026-08-18' }, appState.members);
  expect(html).toContain('出席 2名');
  expect(html.indexOf('Violin')).toBeLessThan(html.indexOf('Viola'));
  expect(html).toContain('いち（遅刻 14:00）');
  expect(html).toContain('未登録 1名');
});
