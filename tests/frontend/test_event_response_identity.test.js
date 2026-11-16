const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperSource = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/members/helpers.js'), 'utf8');
const eventSource = fs.readFileSync(path.resolve(__dirname, '../../src/static/js/modules/members/events.js'), 'utf8');

function fixture(responses) {
    const appState = {
        currentUserMemberId: 1,
        currentUserName: '佐藤花子',
        members: [{ id: 1, last_name: '佐藤', first_name: '花子', maiden_name: '山田' }],
        eventResponses: responses,
    };
    const sandbox = { appState, console, Map, Set };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.portalRuntimeContext = { appState, getById: () => null, today: () => '2026-12-01' };
    vm.runInNewContext(`${helperSource}\n${eventSource}\nglobalThis.__testApi = { ownMemberEventResponses, uniqueEventResponses, currentUserMemberName };`, sandbox);
    return { api: sandbox.__testApi, appState };
}

describe('event response ownership', () => {
    test('current member ID wins even when the display name has changed', () => {
        const { api } = fixture([
            { id: 10, event_id: 55, member_id: 1, name: '旧表示名' },
            { id: 11, event_id: 55, member_id: 2, name: '佐藤(山田)花子' },
        ]);
        expect(api.currentUserMemberName()).toBe('佐藤(山田)花子');
        expect(api.ownMemberEventResponses(55).map((x) => x.id)).toEqual([10]);
    });

    test('never chooses a different member ID based only on the same name', () => {
        const { api } = fixture([{ id: 11, event_id: 55, member_id: 2, name: '佐藤(山田)花子' }]);
        expect(api.ownMemberEventResponses(55)).toEqual([]);
    });

    test('a single legacy name-only row is updatable, ambiguous rows are not', () => {
        const { api, appState } = fixture([{ id: 20, event_id: 55, name: '佐藤(山田)花子' }]);
        expect(api.ownMemberEventResponses(55).map((x) => x.id)).toEqual([20]);
        appState.eventResponses.push({ id: 21, event_id: 55, name: '佐藤(山田)花子' });
        expect(api.ownMemberEventResponses(55)).toEqual([]);
    });

    test('a name-only legacy row is rejected when two members have the same name', () => {
        const { api, appState } = fixture([{ id: 20, event_id: 55, name: '佐藤(山田)花子' }]);
        appState.members.push({ id: 2, last_name: '佐藤', first_name: '花子', maiden_name: '山田' });
        expect(api.ownMemberEventResponses(55)).toEqual([]);
    });

    test('same display name from two different member IDs is counted twice', () => {
        const { api } = fixture([]);
        const rows = [
            { id: 1, member_id: 1, name: '佐藤花子' },
            { id: 2, member_id: 2, name: '佐藤花子' },
            { id: 3, member_id: 1, name: '佐藤花子' },
        ];
        expect(api.uniqueEventResponses(rows).map((x) => x.id)).toEqual([3, 2]);
    });
});
