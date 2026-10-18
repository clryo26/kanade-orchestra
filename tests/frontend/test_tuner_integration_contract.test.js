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

  // Design (Phase 4): opt-in history on this device (storage_local.js) and
  // summary sync to the own account (storage_remote.js). Every other file
  // stays without storage/network access; nothing records or sends audio.
  it('never records, never sends audio; storage and network only in the two storage modules', () => {
    for (const name of tunerScripts) {
      const code = stripComments(read(`${tunerDir}/${name}`));
      expect(code, name).not.toMatch(/MediaRecorder|sendBeacon|XMLHttpRequest/);
      if (name !== 'storage_local.js') expect(code, name).not.toMatch(/indexedDB/);
      if (name !== 'storage_remote.js') expect(code, name).not.toMatch(/\bfetch\b/);
    }
    for (const name of ['storage_local.js', 'storage_remote.js']) {
      const code = stripComments(read(`${tunerDir}/${name}`));
      expect(code, name).not.toMatch(/getUserMedia|MediaStream|AudioContext|AudioWorklet|createAnalyser|getChannelData|spectrogram/i);
    }
    // The upload whitelist carries summaries only (no series, no spectra).
    const remote = require(path.join(root, tunerDir, 'storage_remote.js'));
    const fields = [...remote.SESSION_FIELDS, ...remote.EVENT_FIELDS].join(',');
    expect(fields).not.toMatch(/series|chunk|hz\b|frame|spectr|pcm|audio/i);
    const cleaned = remote.sanitizeSession({ sessionId: 'x', series: [1], chunks: [new Float32Array(4)], summary: { a: NaN, b: new Float32Array(2) } });
    expect(cleaned).toEqual({ sessionId: 'x', summary: { a: null, b: null } });
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

  it('removed the "one note, long" guidance but kept waiting/permission/resume/error guidance', () => {
    for (const name of tunerScripts) {
      const code = read(`${tunerDir}/${name}`);
      expect(code, name).not.toContain('一度に一つの音を');
      expect(code, name).not.toContain('長めに鳴らして');
    }
    expect(read('src/static/css/tuner.css')).not.toContain('.tuner-guide');
    const view = read(`${tunerDir}/view.js`);
    expect(view).toContain('音を待っています');
    expect(view).toContain('マイクを準備しています。許可を求められたら『許可』を選んでください');
    const errors = require(path.join(root, tunerDir, 'errors.js'));
    expect(errors.MESSAGES['resume-required'].action).toBe('resume');
    expect(errors.MESSAGES.denied.action).toBe('retry');
  });

  it('keeps playback on its own audio path, separate from the capture graph', () => {
    const playbackCode = stripComments(read(`${tunerDir}/playback.js`));
    // Its own context or a lease of the shared output manager (behaviour:
    // test_tuner_shared_output.test.js); never the capture graph.
    expect(playbackCode).toContain('gain.connect(out.destination)');
    expect(playbackCode).toContain('env.createContext()');
    expect(playbackCode).toContain("oscillator.type = 'sine'");
    expect(playbackCode).not.toMatch(/getUserMedia|createMediaStreamSource|AudioWorklet|createCaptureGraph/);
    const indexCode = stripComments(read(`${tunerDir}/index.js`));
    // Its own context factory, never the capture controller's context.
    expect(indexCode).toContain('createContext: function () { return new AudioContextCtor(');
    // Playing stops the measurement first-class (microphone released).
    const onPlay = indexCode.slice(indexCode.indexOf('onPlay: function'), indexCode.indexOf('onStop: function'));
    expect(onPlay.indexOf('engine.start(')).toBeLessThan(onPlay.indexOf('controller.stop()'));
    expect(onPlay).not.toMatch(/await|\.then\(/);
    const onStop = indexCode.slice(indexCode.indexOf('onStop: function'), indexCode.indexOf('onRestart: function'));
    expect(onStop).toContain('startOptions.onMeasurementResume(POST_PLAYBACK_DELAY_MS)');
    expect(onStop).not.toMatch(/await|\.then\(/);
  });

  // Settings persistence lives in settings.js (A4 always, other display
  // settings only after "save on this device"); history in storage_local.js.
  it('keeps persistence out of the measuring, playback and drawing modules', () => {
    for (const name of ['temperament.js', 'target_model.js', 'playback.js', 'scheduler.js', 'graph.js', 'index.js', 'display_filter.js', 'controller.js', 'measurement_store.js', 'analysis_stats.js']) {
      const code = stripComments(read(`${tunerDir}/${name}`));
      expect(code, name).not.toMatch(/\.setItem\(|sessionStorage|indexedDB/);
    }
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
    // The common exit releases the tuner first and then the metronome (same laboratory).
    const commonLeave = lab.slice(lab.indexOf('window.portalTunerLeave = function (reason) {'));
    expect(commonLeave.indexOf('leaveTuner(reason);')).toBeGreaterThan(0);
    expect(commonLeave.indexOf('leaveTuner(reason);')).toBeLessThan(commonLeave.indexOf('leaveMetronome(reason);'));
    expect(commonLeave.indexOf('leaveMetronome(reason);')).toBeLessThan(commonLeave.indexOf('};'));
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
    const prepare = routes.slice(routes.indexOf('async function preparePortalTunerHistoryRestore(ticket, tabId)'));
    const order = ['isPortalAuthenticated()', 'canAccessSystemAdmin()', 'ensureImprovementSuggestionsLoaded()', 'preloadPortalTuner()'];
    const positions = order.map((needle) => prepare.indexOf(needle));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const restore = routes.slice(routes.indexOf('async function restorePortalHistoryState('));
    expect(restore.indexOf("tabName === 'system-tuner'")).toBeLessThan(restore.indexOf("$('portalLoginPanel')"));
    // The metronome screen of the laboratory is restored the same way.
    expect(restore.indexOf("tabName === 'system-metronome'")).toBeLessThan(restore.indexOf("$('portalLoginPanel')"));
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

  // tuner.css promises that nothing outside the tuner is styled.
  it('scopes every tuner style rule under .tuner', () => {
    const css = read('src/static/css/tuner.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const outside = [];
    for (const match of css.matchAll(/([^{}]+)\{/g)) {
      const selector = match[1].trim();
      if (selector.startsWith('@')) continue;
      let depth = 0;
      let current = '';
      for (const ch of selector) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { outside.push(current.trim()); current = ''; } else current += ch;
      }
      outside.push(current.trim());
    }
    expect(outside.filter((sel) => !sel.startsWith('.tuner'))).toEqual([]);
  });
});
