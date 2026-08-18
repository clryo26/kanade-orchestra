const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../../src/static/js/modules/absences.js'),
    'utf8',
);

function createSandbox() {
    const appState = {
        currentUserMemberId: 1,
        currentUserName: '団員A',
        schedules: [],
        absences: [],
    };
    const sandbox = {
        console,
        Set,
        Date,
        appState,
        currentUserMemberName: () => '団員A',
        sortedSchedules: (schedules) => [...schedules],
        document: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.portalRuntimeContext = {
        appState,
        today: () => '2026-08-18',
        getById: () => null,
    };
    vm.runInNewContext(`${SOURCE}\nglobalThis.__attendanceReminderTest = { upcomingUnregisteredSchedules, unpresentedUpcomingAttendanceSchedules, markAttendanceReminderPresented };`, sandbox);
    return { appState, api: sandbox.__attendanceReminderTest };
}

function ids(schedules) {
    return schedules.map((schedule) => String(schedule.id));
}

describe('attendance reminder targets', () => {
    test('includes today and seven days later, but excludes past and eight days later', () => {
        const { appState, api } = createSandbox();
        appState.schedules = [
            { id: 'past', date: '2026-08-17' },
            { id: 'today', date: '2026-08-18' },
            { id: 'seven-days', date: '2026-08-25' },
            { id: 'eight-days', date: '2026-08-26' },
        ];

        expect(ids(api.upcomingUnregisteredSchedules())).toEqual(['today', 'seven-days']);
    });

    test('does not present the same target on rerender but presents a newly eligible schedule', () => {
        const { appState, api } = createSandbox();
        appState.schedules = [{ id: 'first', date: '2026-08-18' }];

        const first = api.unpresentedUpcomingAttendanceSchedules();
        expect(ids(first)).toEqual(['first']);
        api.markAttendanceReminderPresented(first);
        expect(ids(api.unpresentedUpcomingAttendanceSchedules())).toEqual([]);

        appState.schedules.push({ id: 'new', date: '2026-08-20' });
        expect(ids(api.unpresentedUpcomingAttendanceSchedules())).toEqual(['new']);
    });

    test('removes answered schedules and can present them again if they become unregistered', () => {
        const { appState, api } = createSandbox();
        appState.schedules = [{ id: 'target', date: '2026-08-18' }];

        const initial = api.unpresentedUpcomingAttendanceSchedules();
        api.markAttendanceReminderPresented(initial);
        appState.absences = [{ id: 1, schedule_id: 'target', member_id: 1, name: '団員A', status: 'present' }];
        expect(ids(api.unpresentedUpcomingAttendanceSchedules())).toEqual([]);

        appState.absences = [];
        expect(ids(api.unpresentedUpcomingAttendanceSchedules())).toEqual(['target']);
    });
});
