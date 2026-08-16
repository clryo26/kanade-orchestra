const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('portal startup and communication stability', () => {
    test('startup guard is first and all later scripts are deferred', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../src/index.html'), 'utf8');
        const scriptTags = [...html.matchAll(/<script\s+src="([^"]+)"([^>]*)><\/script>/g)];
        const startupIndex = scriptTags.findIndex((match) => match[1].includes('/static/js/startup_guard.js'));
        expect(startupIndex).toBeGreaterThanOrEqual(0);
        expect(startupIndex).toBe(0);
        for (let i = 1; i < scriptTags.length; i += 1) {
            expect(scriptTags[i][2]).toMatch(/\bdefer\b/);
        }
        const apiIndex = scriptTags.findIndex((match) => match[1].includes('/common_helpers/api_runtime.js'));
        const retryIndex = scriptTags.findIndex((match) => match[1].includes('/common_helpers/transport_retry.js'));
        const initIndex = scriptTags.findIndex((match) => match[1].includes('/common_helpers/bootstrap_init.js'));
        expect(apiIndex).toBeGreaterThan(startupIndex);
        expect(retryIndex).toBe(apiIndex + 1);
        expect(initIndex).toBe(retryIndex + 1);
    });

    test('GET 503 retries once while POST does not retry', async () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/common_helpers/transport_retry.js'),
            'utf8'
        );
        const responses = [{ status: 503 }, { status: 200 }];
        let calls = 0;
        const context = {
            window: {
                fetchWithTimeout: async () => responses[calls++],
                setTimeout: (fn) => fn(),
            },
            Promise,
            Error,
            Set,
            String,
            Boolean,
        };
        vm.createContext(context);
        vm.runInContext(source, context);
        const result = await context.window.fetchWithTimeout('/api/test', { method: 'GET' }, 1000);
        expect(result.status).toBe(200);
        expect(calls).toBe(2);

        let postCalls = 0;
        const postContext = {
            window: {
                fetchWithTimeout: async () => { postCalls += 1; return { status: 503 }; },
                setTimeout: (fn) => fn(),
            },
            Promise, Error, Set, String, Boolean,
        };
        vm.createContext(postContext);
        vm.runInContext(source, postContext);
        const postResult = await postContext.window.fetchWithTimeout('/api/test', { method: 'POST' }, 1000);
        expect(postResult.status).toBe(503);
        expect(postCalls).toBe(1);
    });

    test('bootstrap endpoint failures do not retain the legacy fan-out fallback', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../src/static/js/modules/bootstrap_loader.js'),
            'utf8'
        );
        expect(source).not.toContain('legacyBootstrapData');
        expect(source).toContain("includeHeavyLists ? '/api/bootstrap' : '/api/bootstrap-core'");
    });
});
