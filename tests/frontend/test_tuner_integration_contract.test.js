import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { checkTunerRelease, tunerFiles } from '../../scripts/generate_tuner_release.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const tunerDir = 'src/static/js/modules/tuner';
const tunerScripts = fs.readdirSync(path.join(root, tunerDir)).filter((name) => name.endsWith('.js'));
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

describe('tuner release id', () => {
  it('is current in every tuner file and in the laboratory launcher URL', () => {
    const { expected, problems } = checkTunerRelease();
    expect(problems).toEqual([]);
    expect(expected).toMatch(/^t-[0-9a-f]{12}$/);
    expect(tunerFiles().map((file) => path.basename(file))).toEqual(expect.arrayContaining(['analysis.worker.js', 'capture.worklet.js', 'tuner.css']));
  });

  it('loads every asset with the same ?rev= (launcher, scripts, CSS, Worker, Worklet, Worker dependencies)', () => {
    const id = checkTunerRelease().expected;
    expect(read('src/static/js/modules/improvement_suggestions.js')).toContain(`'/static/js/modules/tuner/launcher.js?rev=${id}'`);
    const launcher = read(`${tunerDir}/launcher.js`);
    expect(launcher).toContain("var query = '?rev=' + encodeURIComponent(release);");
    expect(launcher).toContain('TUNER_CSS_URL + query');
    expect(launcher).toContain("TUNER_BASE_URL + name + '.js' + query");
    const index = read(`${tunerDir}/index.js`);
    expect(index).toContain("assetUrl('capture.worklet.js')");
    expect(index).toContain("assetUrl('analysis.worker.js')");
    expect(read(`${tunerDir}/analysis.worker.js`)).toContain("importScripts('fft.js' + query, 'pitch.js' + query, 'spectrum.js' + query)");
  });

  it('launcher and body agree on the main script list and each file registers its release', () => {
    const { MAIN_SCRIPTS } = require(path.join(root, tunerDir, 'launcher.js'));
    const index = read(`${tunerDir}/index.js`);
    const listed = JSON.parse(index.match(/var MAIN_MODULES = (\[[^\]]+\]);/)[1].replace(/'/g, '"'));
    expect(listed).toEqual(MAIN_SCRIPTS);
    for (const name of MAIN_SCRIPTS) {
      const source = read(`${tunerDir}/${name}.js`);
      expect(source, name).toMatch(new RegExp(`lib\\.releases(\\.${name}|\\[['"]${name}['"]\\]) = TUNER_RELEASE_ID`));
    }
  });
});

describe('tuner module boundaries', () => {
  it('uses classic scripts only: no import/export, no SharedArrayBuffer', () => {
    for (const name of tunerScripts) {
      const code = stripComments(read(`${tunerDir}/${name}`));
      expect(code, name).not.toMatch(/^\s*(import|export)\s/m);
      expect(code, name).not.toContain('SharedArrayBuffer');
    }
  });

  it('never sends audio or results to a server and never records', () => {
    for (const name of tunerScripts) {
      const code = stripComments(read(`${tunerDir}/${name}`));
      expect(code, name).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|MediaRecorder|indexedDB/);
    }
  });

  it('adds no shared state and only reads auth/permission through portalRuntimeContext', () => {
    for (const name of tunerScripts) {
      const code = stripComments(read(`${tunerDir}/${name}`));
      expect(code, name).not.toMatch(/portalAppState|getAppState|window\.appState/);
      expect(code, name).not.toMatch(/appState\.[A-Za-z_]+\s*=[^=]/);
    }
    expect(read(`${tunerDir}/launcher.js`)).toContain('globalObj.portalRuntimeContext');
  });

  it('adds no COOP/COEP headers for the tuner', () => {
    const backend = ['src/backend/core/static_assets.py', 'src/backend/core/middleware.py'].map(read).join('\n');
    expect(backend).not.toMatch(/Cross-Origin-(Embedder|Opener)-Policy/);
  });

  it('shows no internal file names or storage locations on screen', () => {
    const view = read(`${tunerDir}/view.js`);
    const template = view.slice(view.indexOf('var TEMPLATE'), view.indexOf("].join('\\n')"));
    const errors = require(path.join(root, tunerDir, 'errors.js'));
    const userText = template + JSON.stringify(errors.MESSAGES);
    expect(userText).not.toMatch(/localStorage|portalTuner|\.js\b|static\/|worker|worklet/i);
  });

  it('keeps the laboratory free of tuner internals', () => {
    const lab = stripComments(read('src/static/js/modules/improvement_suggestions.js'));
    // The laboratory may only prepare an AudioContext inside the tap; the
    // microphone, worklet and worker stay inside the tuner modules.
    expect(lab).not.toMatch(/getUserMedia|AudioWorklet|new Worker|createMediaStreamSource/);
  });
});

describe('tuner connection to the portal', () => {
  it('adds no initial script: the laboratory loads the launcher, only for system administrators', () => {
    expect(read('src/index.html')).not.toContain('tuner');
    expect(read('src/static/js/app.js')).not.toContain('tuner');
    const lab = read('src/static/js/modules/improvement_suggestions.js');
    const init = lab.slice(lab.indexOf('    function init() {'));
    expect(init.indexOf('if (isSystemAdministrator())')).toBeGreaterThan(0);
    expect(init.indexOf('ensureTunerLauncherLoaded()')).toBeGreaterThan(init.indexOf('if (isSystemAdministrator())'));
    expect(lab).toContain("return appState.portalAuthVerified === true && appState.currentUserPermission === 'システム管理者';");
    expect(lab).toContain('window.ensurePortalTunerLauncherLoaded = ensureTunerLauncherLoaded;');
    // A failed launcher load must not be cached forever.
    expect(lab).toContain('tunerLauncherPromise = null;');
  });

  it('places the tuner button next to PDF editing and primes inside the tap before switching tabs', () => {
    const lab = read('src/static/js/modules/improvement_suggestions.js');
    const pdf = lab.indexOf('data-tab="system-pdf-editor" type="button">PDF編集</button>');
    const tuner = lab.indexOf('data-tab="system-tuner" type="button">チューナー</button>');
    expect(pdf).toBeGreaterThan(0);
    expect(tuner).toBeGreaterThan(pdf);
    expect(lab).toContain('id="system-tunerTab"');
    expect(lab).toContain('id="systemTunerHost"');
    const handler = stripComments(lab.slice(lab.indexOf("tunerButton.addEventListener('click'")));
    const primeAt = handler.indexOf('window.PortalTunerLauncher.prime()');
    const prepareAt = handler.indexOf('prepareTunerTap()');
    const switchAt = handler.indexOf("switchTab('systemPanel', 'system-tuner', false)");
    expect(primeAt).toBeGreaterThan(0);
    // Without the launcher, the tap still prepares audio synchronously itself.
    expect(prepareAt).toBeGreaterThan(primeAt);
    expect(switchAt).toBeGreaterThan(prepareAt);
    expect(handler.slice(0, switchAt)).not.toMatch(/await|\.then\(/);
    const prepare = stripComments(lab.slice(lab.indexOf('function prepareTunerTap()'), lab.indexOf('function cancelPendingTunerTap()')));
    expect(prepare).toContain('new Ctor(');
    expect(prepare).toContain('ctx.resume()');
    expect(prepare).not.toMatch(/await|\.then\(/);
    // The handover re-checks the request (cleared by leaving) and the whole screen (parent panels too).
    expect(handler).toContain('ensureTunerLauncherLoaded().then(startRequestedTuner)');
    const handover = stripComments(lab.slice(lab.indexOf('function startRequestedTuner(launcher)'), lab.indexOf('function handleTunerPageHidden()')));
    expect(handover.indexOf('if (!tunerStartRequested) return;')).toBeLessThan(handover.indexOf('launcher.adoptPrimed('));
    expect(handover.indexOf('tunerScreenIsShowing()')).toBeLessThan(handover.indexOf('launcher.adoptPrimed('));
    const leave = lab.slice(lab.indexOf('function leaveTuner(reason)'));
    expect(leave.indexOf('tunerStartRequested = false;')).toBeLessThan(leave.indexOf('PortalTunerLauncher.leave(reason)'));
    expect(leave.indexOf('cancelPendingTunerTap()')).toBeLessThan(leave.indexOf('PortalTunerLauncher.leave(reason)'));
    expect(leave).toContain('window.invalidatePortalNavigation()');
    // Before the launcher exists, background/page hide release the pending tap's context here.
    expect(lab).toContain("document.addEventListener('visibilitychange'");
    expect(lab).toContain("window.addEventListener('pagehide', handleTunerPageHidden);");
    expect(lab).toContain('window.portalTunerLeave = leaveTuner;');
    const showSuggestions = lab.slice(lab.indexOf('async function showImprovementSuggestions()'));
    expect(showSuggestions.indexOf("leaveTuner('improvement-suggestions')")).toBeLessThan(showSuggestions.indexOf("$('systemPanel').hidden = true"));
  });

  it('switchTab leaves for every other tab and enters only after the tuner tab is visible', () => {
    const routes = read('src/static/js/modules/navigation/routes.js');
    const switchTab = routes.slice(routes.indexOf('async function switchTab('));
    expect(switchTab.indexOf("if (!isTunerTab) leavePortalTuner('tab');")).toBeGreaterThan(0);
    expect(switchTab.indexOf('if (isTunerTab) enterPortalTunerTab();')).toBeGreaterThan(switchTab.indexOf('if (target) target.hidden = false;'));
    expect(switchTab).toContain("if (panelId === 'systemPanel' && tabName === 'system-laboratory') void preloadPortalTuner();");
    for (const fn of ['function showAdminPanel(', 'function showSystemPanel()', 'function showMemberTab(']) {
      const body = routes.slice(routes.indexOf(fn), routes.indexOf(fn) + 200);
      expect(body, fn).toContain('leavePortalTuner(');
    }
  });

  it('history restore of the tuner checks auth, loads the laboratory, then the tuner body', () => {
    const routes = read('src/static/js/modules/navigation/routes.js');
    const prepare = routes.slice(routes.indexOf('async function preparePortalTunerHistoryRestore(ticket)'));
    const order = ['isPortalAuthenticated()', 'canAccessSystemAdmin()', 'ensureImprovementSuggestionsLoaded()', 'preloadPortalTuner()'];
    const positions = order.map((needle) => prepare.indexOf(needle));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const restore = routes.slice(routes.indexOf('async function restorePortalHistoryState('));
    expect(restore.indexOf("tabName === 'system-tuner'")).toBeLessThan(restore.indexOf("$('portalLoginPanel')"));
  });

  it('logout, login screen and auth clearing release the tuner first', () => {
    const auth = read('src/static/js/auth_feature.js');
    const logout = auth.slice(auth.indexOf('async function logoutPortal()'));
    expect(logout.indexOf("portalTunerLeave('logout')")).toBeGreaterThan(0);
    expect(logout.indexOf("portalTunerLeave('logout')")).toBeLessThan(logout.indexOf('await ensureNotificationsLoaded()'));
    const login = auth.slice(auth.indexOf('function showPortalLogin()'));
    expect(login.indexOf("portalTunerLeave('login')")).toBeLessThan(login.indexOf("$('adminPanel').hidden = true"));
    const runtime = read('src/static/js/modules/common_helpers/api_runtime.js');
    const clear = runtime.slice(runtime.indexOf('function clearPortalAuthState()'));
    expect(clear.indexOf("portalTunerLeave('auth-cleared')")).toBeLessThan(clear.indexOf('localStorage.removeItem'));
    const events = read('src/static/js/modules/navigation/events.js');
    expect(events.slice(events.indexOf('function logoutPortal()'))).toContain("portalTunerLeave('logout')");
  });
});
