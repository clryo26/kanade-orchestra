const fs = require('node:fs');
const vm = require('node:vm');
const loaderPath = 'src/static/js/modules/bootstrap_loader.js';
const memberPath = 'src/static/js/modules/members/render.js';
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function createCdeHarness(respond = async () => [], sources = {}) {
    const counts = {}, applied = {}, sends = [];
    const state = new Proxy({ currentUserMemberId: 1, portalAuthGeneration: 'one', promotionLoadState: 'idle' }, {
        set(target, key, value) { applied[key] = (applied[key] || 0) + 1; target[key] = value; return true; },
    });
    const ctx = { console, Date, setTimeout, clearTimeout, URL,
        document: { addEventListener() {} }, localStorage: { getItem: () => 'device' },
        portalResponseEpoch: 0, showAlert: (...args) => { (ctx.alerts ||= []).push(args); },
        portalRuntimeContext: { appState: state, getById: () => null },
    };
    ctx.window = ctx;
    ctx.portalCacheIdentity = () => JSON.stringify([state.currentUserMemberId, state.portalAuthGeneration]);
    const network = new Map();
    ctx.request = (url, options = {}) => {
        const key = JSON.stringify([url, ctx.portalCacheIdentity(), ctx.portalResponseEpoch, !!options._forceRevalidate]);
        if (network.has(key)) return network.get(key);
        sends.push({ url, options });
        const pending = Promise.resolve().then(() => respond(url, options)).finally(() => network.delete(key));
        network.set(key, pending);
        return pending;
    };
    vm.createContext(ctx);
    const loader = sources.loader || fs.readFileSync(loaderPath, 'utf8');
    const members = sources.members || fs.readFileSync(memberPath, 'utf8');
    vm.runInContext(members, ctx);
    for (const name of new Set((loader + members).match(/\b(?:render[A-Z]\w*|refreshPartSelectOptions|refreshVenueOptions|applyOrgSettings|bindSheetLibraryFilters)\b/g))) {
        if (name === 'renderMemberExtraViews') continue;
        ctx[name] = () => { counts[name] = (counts[name] || 0) + 1; };
    }
    vm.runInContext(loader, ctx);
    // Keep the real member dispatcher; count its leaf calls, not a copy.
    vm.runInContext(members.slice(
        members.indexOf('function renderMemberExtraViews('), members.indexOf('\nfunction renderCastingMembersList(')), ctx);
    return { ctx, state, counts, applied, sends };
}
module.exports = { createCdeHarness, deferred };
