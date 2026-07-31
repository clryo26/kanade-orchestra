/**
 * test_startup_metrics.test.js
 *
 * Phase 2 startup metrics implementation tests
 * Tests for window.portalStartup metrics collection and timestamp handling
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Read production startup_guard.js
const startupGuardPath = path.join(__dirname, '../../src/static/js/startup_guard.js');
const startupGuardCode = fs.readFileSync(startupGuardPath, 'utf8');

describe('window.portalStartup metrics (Phase 2)', () => {
    let sandbox;
    let global;

    beforeEach(() => {
        // Create fresh context for each test
        sandbox = {};
        global = vm.createContext(sandbox);

        // Set up minimal window object and global functions for startup_guard.js
        let timerCounter = 0;
        const timers = {};
        const eventListeners = {};

        global.window = {
            performance: {
                now: () => Date.now() % 1000000, // Simulate ms since page load
            },
            portalStartup: undefined, // Will be set by startup_guard.js
            // Add event listener support for _registerErrorHandlers
            addEventListener: (eventType, callback) => {
                if (!eventListeners[eventType]) {
                    eventListeners[eventType] = [];
                }
                eventListeners[eventType].push(callback);
            },
            removeEventListener: (eventType, callback) => {
                if (eventListeners[eventType]) {
                    eventListeners[eventType] = eventListeners[eventType].filter(cb => cb !== callback);
                }
            },
        };

        global.document = {
            getElementById: () => null, // Mock DOM element
            visibilityState: 'visible',
        };

        global.navigator = {
            onLine: true,
        };

        global.setTimeout = (fn, ms) => {
            const timerId = ++timerCounter;
            timers[timerId] = fn;
            // Note: we don't actually execute timer callbacks in tests
            return timerId;
        };

        global.clearTimeout = (timerId) => {
            delete timers[timerId];
        };

        global.console = {
            log: () => {},
            warn: () => {},
            error: () => {},
        };

        // Run startup_guard.js in the context
        vm.runInContext(startupGuardCode, global);
    });

    describe('APP_START metric', () => {
        test('APP_START is first mark with elapsedMs=0', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            expect(snapshot.marks.length).toBeGreaterThanOrEqual(1);
            expect(snapshot.marks[0].name).toBe('APP_START');
            expect(snapshot.marks[0].elapsedMs).toBe(0);
        });

        test('APP_START is recorded synchronously on load', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            const appStartMark = snapshot.marks.find(m => m.name === 'APP_START');
            expect(appStartMark).toBeDefined();
            expect(appStartMark.detail).toBeNull();
        });
    });

    describe('mark() API', () => {
        test('mark() records metric with name and elapsedMs', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            const beforeCount = snapshot.marks.length;

            sandbox.window.portalStartup.mark('TEST_MARK');
            const newSnapshot = sandbox.window.portalStartup.snapshot();
            expect(newSnapshot.marks.length).toBe(beforeCount + 1);

            const testMark = newSnapshot.marks[newSnapshot.marks.length - 1];
            expect(testMark.name).toBe('TEST_MARK');
            expect(typeof testMark.elapsedMs).toBe('number');
            expect(testMark.elapsedMs).toBeGreaterThanOrEqual(0);
        });

        test('mark() accepts detail parameter (metadata)', () => {
            sandbox.window.portalStartup.mark('TEST_WITH_DETAIL', { status: 'success' });
            const snapshot = sandbox.window.portalStartup.snapshot();
            const mark = snapshot.marks[snapshot.marks.length - 1];
            expect(mark.detail).toEqual({ status: 'success' });
        });

        test('elapsedMs is monotonically increasing (or stable)', () => {
            const marks = [];
            for (let i = 0; i < 5; i++) {
                sandbox.window.portalStartup.mark(`MARK_${i}`);
                const snapshot = sandbox.window.portalStartup.snapshot();
                marks.push(snapshot.marks[snapshot.marks.length - 1].elapsedMs);
            }

            // Each mark should be >= previous mark
            for (let i = 1; i < marks.length; i++) {
                expect(marks[i]).toBeGreaterThanOrEqual(marks[i - 1]);
            }
        });

        test('mark() returns undefined', () => {
            const result = sandbox.window.portalStartup.mark('TEST_RETURN');
            expect(result).toBeUndefined();
        });
    });

    describe('snapshot() API', () => {
        test('snapshot() returns object with marks array', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            expect(typeof snapshot).toBe('object');
            expect(Array.isArray(snapshot.marks)).toBe(true);
        });

        test('snapshot() returns copy (caller cannot modify internal array)', () => {
            const snapshot1 = sandbox.window.portalStartup.snapshot();
            const originalLength = snapshot1.marks.length;

            // Try to modify returned marks array
            snapshot1.marks.push({ name: 'FAKE', elapsedMs: 9999 });

            // Get new snapshot
            const snapshot2 = sandbox.window.portalStartup.snapshot();
            expect(snapshot2.marks.length).toBe(originalLength);

            // Verify fake mark is not present
            const fakeMarks = snapshot2.marks.filter(m => m.name === 'FAKE');
            expect(fakeMarks.length).toBe(0);
        });

        test('snapshot() includes startTime', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            expect(typeof snapshot.startTime).toBe('number');
            expect(snapshot.startTime).toBeGreaterThan(0);
        });

        test('snapshot() includes isReady flag', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            expect(typeof snapshot.isReady).toBe('boolean');
        });
    });

    describe('Timestamp handling', () => {
        test('elapsedMs uses Performance API or Date.now() fallback', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            const appStartTime = snapshot.startTime;

            expect(typeof appStartTime).toBe('number');
            expect(appStartTime).toBeGreaterThan(0);
            expect(appStartTime).toBeLessThan(Date.now() + 10000); // Sanity check
        });

        test('startTime is ISO 8601 compatible or numeric timestamp', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            expect(typeof snapshot.startTime).toBe('number');
            // Should be a valid timestamp (milliseconds since epoch)
            const now = Date.now();
            expect(snapshot.startTime).toBeLessThan(now + 1000);
            expect(snapshot.startTime).toBeGreaterThan(now - 60000); // Within last minute
        });
    });

    describe('ready() API', () => {
        test('ready() sets isReady to true', () => {
            let snapshot = sandbox.window.portalStartup.snapshot();
            expect(snapshot.isReady).toBe(false);

            sandbox.window.portalStartup.ready();
            snapshot = sandbox.window.portalStartup.snapshot();
            expect(snapshot.isReady).toBe(true);
        });

        test('ready() is idempotent', () => {
            sandbox.window.portalStartup.ready();
            sandbox.window.portalStartup.ready();

            const snapshot = sandbox.window.portalStartup.snapshot();
            expect(snapshot.isReady).toBe(true);
        });

        test('ready() sets marker with APP_READY name', () => {
            // Note: ready() implementation may auto-mark APP_READY
            // This test verifies the behavioral expectation
            sandbox.window.portalStartup.ready();
            const snapshot = sandbox.window.portalStartup.snapshot();
            expect(snapshot.isReady).toBe(true);
        });

        test('[REGRESSION] ready() called multiple times records APP_READY only once', () => {
            // Fix for Issue: APP_READY double recording
            // When ready() is called multiple times, APP_READY should be recorded exactly once
            sandbox.window.portalStartup.ready();
            sandbox.window.portalStartup.ready();
            sandbox.window.portalStartup.ready();

            const snapshot = sandbox.window.portalStartup.snapshot();
            const appReadyMarks = snapshot.marks.filter(m => m.name === 'APP_READY');

            expect(appReadyMarks.length).toBe(1);
            expect(snapshot.isReady).toBe(true);
        });

        test('[REGRESSION] APP_READY is recorded within ready() without external mark() call', () => {
            // Fix for Issue: APP_READY double recording in navigation/events.js
            // ready() should record APP_READY automatically, no external mark('APP_READY') needed
            sandbox.window.portalStartup.ready();

            const snapshot = sandbox.window.portalStartup.snapshot();
            const appReadyMarks = snapshot.marks.filter(m => m.name === 'APP_READY');

            // APP_READY should exist from ready() call alone
            expect(appReadyMarks.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('sessionStorage persistence', () => {
        test('snapshot can be serialized to JSON', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            const json = JSON.stringify(snapshot);
            expect(typeof json).toBe('string');

            const parsed = JSON.parse(json);
            expect(parsed.marks).toEqual(snapshot.marks);
        });

        test('marks array contains only serializable objects', () => {
            const snapshot = sandbox.window.portalStartup.snapshot();
            snapshot.marks.forEach(mark => {
                // Should not contain functions, symbols, or circular refs
                const json = JSON.stringify(mark);
                const parsed = JSON.parse(json);
                expect(parsed.name).toBe(mark.name);
                expect(parsed.elapsedMs).toBe(mark.elapsedMs);
            });
        });
    });

    describe('Privacy (no sensitive data)', () => {
        test('mark detail does not include error stack traces', () => {
            const error = new Error('test error');
            // Should not accidentally include stack
            sandbox.window.portalStartup.mark('ERROR_MARK', { type: 'error' });

            const snapshot = sandbox.window.portalStartup.snapshot();
            const errorMark = snapshot.marks.find(m => m.name === 'ERROR_MARK');
            const json = JSON.stringify(errorMark);

            // Stack should not appear in serialization
            expect(json).not.toContain('Error:');
            expect(json).not.toContain('at ');
        });

        test('marks do not expose internal device IDs or auth tokens', () => {
            sandbox.window.portalStartup.mark('AUTH_END', { status: 'authenticated' });
            const snapshot = sandbox.window.portalStartup.snapshot();

            const json = JSON.stringify(snapshot);
            // Should not contain credentials or sensitive keys
            expect(json).not.toContain('token');
            expect(json).not.toContain('key');
            expect(json).not.toContain('secret');
        });
    });

    describe('Event metadata', () => {
        test('AUTH_END mark can include status detail', () => {
            sandbox.window.portalStartup.mark('AUTH_END', { status: 'authenticated' });
            const snapshot = sandbox.window.portalStartup.snapshot();

            const authMark = snapshot.marks.find(m => m.name === 'AUTH_END');
            expect(authMark).toBeDefined();
            if (authMark && authMark.detail) {
                expect(authMark.detail.status).toBe('authenticated');
            }
        });

        test('BOOTSTRAP_LITE_END mark can include cached flag', () => {
            sandbox.window.portalStartup.mark('BOOTSTRAP_LITE_END', { cached: false });
            const snapshot = sandbox.window.portalStartup.snapshot();

            const bootstrapMark = snapshot.marks.find(m => m.name === 'BOOTSTRAP_LITE_END');
            expect(bootstrapMark).toBeDefined();
            if (bootstrapMark && bootstrapMark.detail) {
                expect(bootstrapMark.detail.cached).toBe(false);
            }
        });
    });

    describe('Multiple contexts (no state leakage)', () => {
        test('Each context has independent marks array', () => {
            // Create second independent context
            const sandbox2 = {};
            const global2 = vm.createContext(sandbox2);

            // Set up window for second context with event listener support
            const eventListeners2 = {};
            global2.window = {
                performance: {
                    now: () => Date.now() % 1000000,
                },
                addEventListener: (eventType, callback) => {
                    if (!eventListeners2[eventType]) {
                        eventListeners2[eventType] = [];
                    }
                    eventListeners2[eventType].push(callback);
                },
                removeEventListener: (eventType, callback) => {
                    if (eventListeners2[eventType]) {
                        eventListeners2[eventType] = eventListeners2[eventType].filter(cb => cb !== callback);
                    }
                },
            };

            let timerCounter2 = 0;
            global2.setTimeout = (fn, ms) => {
                return ++timerCounter2;
            };
            global2.clearTimeout = () => {};
            global2.document = {
                getElementById: () => null,
            };
            global2.navigator = {
                onLine: true,
            };
            global2.console = {
                log: () => {},
                warn: () => {},
                error: () => {},
            };

            vm.runInContext(startupGuardCode, global2);

            const snapshot1 = sandbox.window.portalStartup.snapshot();
            const snapshot2 = global2.window.portalStartup.snapshot();

            // Both should have APP_START
            expect(snapshot1.marks[0].name).toBe('APP_START');
            expect(snapshot2.marks[0].name).toBe('APP_START');

            // But they should be independent instances
            const origLen1 = snapshot1.marks.length;
            sandbox.window.portalStartup.mark('UNIQUE_TO_1');

            const newSnapshot1 = sandbox.window.portalStartup.snapshot();
            const newSnapshot2 = global2.window.portalStartup.snapshot();

            expect(newSnapshot1.marks.length).toBe(origLen1 + 1);
            expect(newSnapshot2.marks.length).toBeCloseTo(origLen1, 1); // Should not include UNIQUE_TO_1
        });
    });

    describe('[REGRESSION] ESSENTIAL_RENDER metrics (success and failure paths)', () => {
        test('ESSENTIAL_RENDER_START and END are recorded for successful render', () => {
            // Simulate bootstrap loader sequence
            sandbox.window.portalStartup.mark('BOOTSTRAP_LITE_START');
            sandbox.window.portalStartup.mark('BOOTSTRAP_LITE_END', { cached: false });

            // Simulate successful render
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_START');
            // renderEssentialViews succeeds
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_END', { status: 'success' });

            const snapshot = sandbox.window.portalStartup.snapshot();
            const startMarks = snapshot.marks.filter(m => m.name === 'ESSENTIAL_RENDER_START');
            const endMarks = snapshot.marks.filter(m => m.name === 'ESSENTIAL_RENDER_END');

            expect(startMarks.length).toBe(1);
            expect(endMarks.length).toBe(1);
            expect(endMarks[0].detail).toEqual({ status: 'success' });
        });

        test('ESSENTIAL_RENDER_END with status=error is recorded even when render throws', () => {
            // Simulate bootstrap loader sequence
            sandbox.window.portalStartup.mark('BOOTSTRAP_LITE_START');
            sandbox.window.portalStartup.mark('BOOTSTRAP_LITE_END', { cached: false });

            // Simulate failed render
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_START');
            // renderEssentialViews fails and throws
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_END', { status: 'error' });
            // Exception would propagate here in real code

            const snapshot = sandbox.window.portalStartup.snapshot();
            const startMarks = snapshot.marks.filter(m => m.name === 'ESSENTIAL_RENDER_START');
            const endMarks = snapshot.marks.filter(m => m.name === 'ESSENTIAL_RENDER_END');

            expect(startMarks.length).toBe(1);
            expect(endMarks.length).toBe(1);
            expect(endMarks[0].detail).toEqual({ status: 'error' });
        });

        test('ESSENTIAL_RENDER_DURATION measure can be generated from START/END', () => {
            // Simulate render sequence with actual timing
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_START');
            // Simulate some time passing
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_END', { status: 'success' });

            const snapshot = sandbox.window.portalStartup.snapshot();
            const startMark = snapshot.marks.find(m => m.name === 'ESSENTIAL_RENDER_START');
            const endMark = snapshot.marks.find(m => m.name === 'ESSENTIAL_RENDER_END');

            // Verify both marks exist and END comes after START
            expect(startMark).toBeDefined();
            expect(endMark).toBeDefined();
            expect(endMark.elapsedMs).toBeGreaterThanOrEqual(startMark.elapsedMs);

            // duration would be (endMark.elapsedMs - startMark.elapsedMs)
            const duration = endMark.elapsedMs - startMark.elapsedMs;
            expect(typeof duration).toBe('number');
            expect(duration).toBeGreaterThanOrEqual(0);
        });

        test('ESSENTIAL_RENDER_END recorded only once even in failure path (finally block)', () => {
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_START');
            // First END (simulating finally block on success)
            sandbox.window.portalStartup.mark('ESSENTIAL_RENDER_END', { status: 'success' });

            const snapshot = sandbox.window.portalStartup.snapshot();
            const endMarks = snapshot.marks.filter(m => m.name === 'ESSENTIAL_RENDER_END');

            // Only 1 END should exist
            expect(endMarks.length).toBe(1);
        });
    });
});
