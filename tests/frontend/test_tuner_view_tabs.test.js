import fs from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

const source = fs.readFileSync('src/static/js/modules/tuner/view_tabs.js', 'utf8');
// Minimal DOM for the public tab API; geometry/sticky behavior belongs in E2E.
function setup({ observer = true, events = true } = {}) {
  let focused = null;
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; }
    setAttribute(k, v) { this.attrs[k] = v; }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
      child.parent = this;
      return child;
    }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    get firstChild() { return this.children[0]; }
    matches(selector) {
      if (selector.startsWith('.')) return this.className === selector.slice(1);
      return Object.hasOwn(this.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
    }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    focus() { focused = this; }
  }
  const properties = {};
  const doc = {
    navbar: null,
    documentElement: { style: { setProperty: (key, value) => { properties[key] = value; } } },
    createElement: () => new Element(),
    querySelector: vi.fn(() => doc.navbar),
  };
  const observers = [];
  const listeners = {};
  const window = { document: doc, getComputedStyle: (el) => el.style, MutationObserver: vi.fn() };
  if (events) window.addEventListener = vi.fn((type, fn) => { listeners[type] = fn; });
  if (observer) window.ResizeObserver = class {
    constructor(notify) { this.notify = notify; this.observe = vi.fn(); this.unobserve = vi.fn(); observers.push(this); }
  };
  const context = vm.createContext({ window });
  vm.runInContext(source, context);
  const navbar = (height = 58.5) => ({
    height, width: 390, rects: 1, style: { display: 'flex', visibility: 'visible' },
    getClientRects() { return Array(this.rects).fill({}); },
    getBoundingClientRect() { return { width: this.width, height: this.height }; },
  });
  return {
    doc, navbar, observers, listeners, window, root: () => new Element(),
    create: (...args) => window.PortalTunerLib.viewTabs.createTabs(...args),
    offset: () => properties['--tuner-tabbar-top'], focus: () => focused,
    reload: () => vm.runInContext(source, context),
  };
}

describe('tuner navbar offset', () => {
  it('measures synchronously before API reuse, sharing one observer/listener across roots and script reloads', () => {
    const s = setup();
    s.doc.navbar = s.navbar();
    const root = s.root();
    const api = s.create(root);
    expect(s.offset()).toBe('58.5px');
    s.doc.navbar.height = 101;
    expect(s.create(root)).toBe(api);
    expect(s.offset()).toBe('101px');
    s.create(s.root());
    s.reload();
    s.create(s.root());
    expect(s.observers).toHaveLength(1);
    expect(s.observers[0].observe).toHaveBeenCalledTimes(1);
    expect(s.window.addEventListener).toHaveBeenCalledTimes(1);
    expect(s.window.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(s.window.MutationObserver).not.toHaveBeenCalled();
  });

  for (const entry of ['create', 'resize', 'observer']) {
    it(`reacquires added/replaced/removed navbars through ${entry}`, () => {
      const s = setup();
      const root = s.root();
      s.create(root);
      expect(s.offset()).toBe('0px');
      const update = () => entry === 'create' ? s.create(root) : entry === 'resize' ? s.listeners.resize() : s.observers[0].notify();
      const first = s.doc.navbar = s.navbar(62);
      update();
      expect(s.offset()).toBe('62px');
      expect(s.observers[0].observe).toHaveBeenLastCalledWith(first, { box: 'border-box' });
      const second = s.doc.navbar = s.navbar(96);
      update();
      expect(s.offset()).toBe('96px');
      expect(s.doc.querySelector).toHaveBeenLastCalledWith('nav.navbar.sticky-top');
      expect(s.observers[0].unobserve.mock.invocationCallOrder.at(-1))
        .toBeLessThan(s.observers[0].observe.mock.invocationCallOrder.at(-1));
      expect(s.observers[0].unobserve).toHaveBeenCalledWith(first);
      expect(s.observers[0].observe).toHaveBeenLastCalledWith(second, { box: 'border-box' });
      s.doc.navbar = null;
      update();
      expect(s.offset()).toBe('0px');
      expect(s.observers[0].unobserve).toHaveBeenLastCalledWith(second);
    });
  }

  it('updates size and visibility without retaining a removed tuner root', () => {
    const s = setup();
    s.doc.navbar = s.navbar();
    const host = s.root();
    host.appendChild(s.root());
    s.create(host.firstChild);
    host.firstChild.remove(); // detach the entire tuner
    expect(host.children).toHaveLength(0);
    expect(s.offset()).toBe('58.5px');
    s.doc.navbar.height = 120;
    expect(() => s.observers[0].notify()).not.toThrow();
    expect(s.offset()).toBe('120px');
    s.doc.navbar.style.visibility = 'hidden';
    s.listeners.resize();
    expect(s.offset()).toBe('0px');
    s.doc.navbar.style.visibility = 'visible';
    s.observers[0].notify();
    expect(s.offset()).toBe('120px');
  });

  for (const patch of [
    { height: NaN }, { height: Infinity }, { height: -Infinity }, { height: -1 }, { height: 0 },
    { width: 0 }, { rects: 0 }, { style: { display: 'none' } },
    { style: { visibility: 'collapse' } },
  ]) {
    it(`uses zero for unavailable geometry ${JSON.stringify(patch)}`, () => {
      const s = setup();
      s.doc.navbar = Object.assign(s.navbar(), patch);
      s.create(s.root());
      expect(s.offset()).toBe('0px');
    });
  }

  it('works without optional observation/event APIs', () => {
    for (const events of [true, false]) {
      const s = setup({ observer: false, events });
      s.doc.navbar = s.navbar(74);
      expect(() => s.create(s.root())).not.toThrow();
      expect(s.offset()).toBe('74px');
      s.doc.navbar.height = 90;
      if (events) s.listeners.resize();
      else s.create(s.root());
      expect(s.offset()).toBe('90px');
    }
  });
});

describe('existing tuner tab contract', () => {
  for (const entry of ['create', 'resize', 'observer']) {
    it(`keeps selection, focus, panels and callbacks unchanged during ${entry} remeasurement across hosts`, () => {
      const s = setup();
      s.doc.navbar = s.navbar(72);
      const roots = [s.root(), s.root()];
      const handlers = roots.map(() => ({ onTab: vi.fn() }));
      const apis = roots.map((root, i) => s.create(root, handlers[i]));
      apis[0].select('analyzer', true);
      apis[1].select('menu');
      const children = roots.map((root) => [...root.children]);
      const panels = apis.map((api, i) => api.panel(i === 0 ? 'analyzer' : 'menu'));
      const focus = s.focus();
      handlers.forEach(({ onTab }) => onTab.mockClear());
      const replacement = s.doc.navbar = s.navbar(108.25);
      const update = () => {
        if (entry === 'create') roots.forEach((root, i) => expect(s.create(root)).toBe(apis[i]));
        else if (entry === 'resize') s.listeners.resize();
        else s.observers[0].notify();
      };
      update();
      expect(s.offset()).toBe('108.25px');
      expect(s.observers[0].observe).toHaveBeenLastCalledWith(replacement, { box: 'border-box' });
      roots.forEach((root, i) => {
        const id = i === 0 ? 'analyzer' : 'menu';
        expect(root.children).toEqual(children[i]);
        expect(root.dataset.tab).toBe(id);
        expect(apis[i].current()).toBe(id);
        expect(apis[i].panel(id)).toBe(panels[i]);
        expect(panels[i].hidden).toBe(false);
        ['measure', 'sound', 'analyzer', 'trainer', 'diagnosis', 'menu'].forEach((other, index) => {
          expect(apis[i].isVisible(other)).toBe(other === id);
          expect(apis[i].panel(other).hidden).toBe(other !== id);
          expect(root.firstChild.children[index].tabIndex).toBe(other === id ? 0 : -1);
          expect(root.firstChild.children[index].attrs['aria-selected']).toBe(String(other === id));
        });
        expect(root.firstChild.children.filter((button) => button.attrs['aria-selected'] === 'true'))
          .toEqual([root.firstChild.children[i === 0 ? 2 : 5]]);
        expect(handlers[i].onTab).not.toHaveBeenCalled();
      });
      expect(s.focus()).toBe(focus);
      expect(s.observers).toHaveLength(1);
      expect(s.window.addEventListener).toHaveBeenCalledTimes(1);
    });
  }

  it('preserves content order, API, ARIA, click and keyboard focus semantics', () => {
    const s = setup();
    const root = s.root();
    const content = s.root();
    const playback = s.root(); playback.className = 'tuner-playback';
    const status = s.root(); status.dataset.tunerStatus = 'true';
    const statusbar = s.root(); statusbar.dataset.tunerStatusbar = 'true';
    const announcer = s.root(); announcer.dataset.tunerAnnouncer = 'true';
    [content, playback, status, statusbar, announcer].forEach((el) => root.appendChild(el));
    const onTab = vi.fn();
    const api = s.create(root, { onTab });
    const bar = root.firstChild;
    expect(Object.keys(api).sort()).toEqual(['current', 'isVisible', 'panel', 'select']);
    const ids = ['measure', 'sound', 'analyzer', 'trainer', 'diagnosis', 'menu'];
    expect(bar.attrs).toMatchObject({ role: 'tablist', 'aria-label': 'チューナーの画面' });
    expect(bar.children.map((b) => b.textContent)).toEqual(['測定', '音源', '解析', '練習', '診断', '履歴・楽器・設定']);
    expect(root.children).toEqual([bar, status, statusbar, ...ids.map(api.panel), announcer]);
    expect(api.panel('measure').children).toEqual([content]);
    expect(api.panel('sound').children).toEqual([playback]);
    const check = (id) => {
      expect(api.current()).toBe(id);
      expect(root.dataset.tab).toBe(id);
      ids.forEach((other, i) => {
        expect(api.isVisible(other)).toBe(other === id);
        expect(api.panel(other).hidden).toBe(other !== id);
        expect(bar.children[i].id).toBe(`tunerTab-${other}`);
        expect(api.panel(other).id).toBe(`tunerPanel-${other}`);
        expect(api.panel(other).attrs).toMatchObject({ role: 'tabpanel', 'aria-labelledby': `tunerTab-${other}` });
        expect(bar.children[i].attrs).toMatchObject({ role: 'tab', 'aria-controls': `tunerPanel-${other}`, 'aria-selected': String(other === id) });
        expect(bar.children[i].tabIndex).toBe(other === id ? 0 : -1);
      });
    };
    check('measure');
    expect(onTab).toHaveBeenCalledExactlyOnceWith('measure');
    bar.listeners.click({ target: bar.children[1] });
    check('sound');
    expect(s.focus()).toBeNull();
    expect(onTab).toHaveBeenLastCalledWith('sound');
    // Clicking selects a panel without explicitly moving an existing focus.
    const externalControl = s.root();
    externalControl.focus();
    const label = s.root();
    bar.children[2].appendChild(label);
    bar.listeners.click({ target: label });
    check('analyzer');
    expect(s.focus()).toBe(externalControl);
    expect(onTab).toHaveBeenLastCalledWith('analyzer');
    for (const [key, id] of [['End', 'menu'], ['ArrowRight', 'measure'], ['ArrowLeft', 'menu'], ['Home', 'measure'], ['ArrowRight', 'sound'], ['ArrowRight', 'analyzer'], ['ArrowLeft', 'sound'], ['Home', 'measure']]) {
      const preventDefault = vi.fn();
      bar.listeners.keydown({ key, preventDefault });
      check(id);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(s.focus()).toBe(bar.children[ids.indexOf(id)]);
      expect(onTab).toHaveBeenLastCalledWith(id);
    }
    const calls = onTab.mock.calls.length;
    const previousFocus = s.focus();
    const preventDefault = vi.fn();
    bar.listeners.keydown({ key: 'Tab', preventDefault });
    bar.listeners.click({ target: bar });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(s.focus()).toBe(previousFocus);
    api.select('unknown');
    expect(onTab).toHaveBeenCalledTimes(calls);
    expect(api.panel('unknown')).toBeNull();
    check('measure');
    const replacementHandler = vi.fn();
    expect(s.create(root, { onTab: replacementHandler })).toBe(api);
    expect(onTab).toHaveBeenCalledTimes(calls);
    api.select('trainer', true);
    check('trainer');
    expect(s.focus()).toBe(bar.children[3]);
    expect(onTab).toHaveBeenLastCalledWith('trainer');
    expect(replacementHandler).not.toHaveBeenCalled();
    expect(root.children.filter((el) => el.dataset.tunerTabbar)).toHaveLength(1);
  });
});

// Keep the existing integration selector-scope test; this additionally limits
// the shared dimension's consumer and protects sticky/maximized invariants.
describe('tuner sticky CSS contract', () => {
  const css = fs.readFileSync('src/static/css/tuner.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  it('consumes the shared offset only on the tabbar and retains its stacking/scrolling', () => {
    const consumers = rules.filter(([, , body]) => body.includes('var(--tuner-tabbar-top'));
    expect(consumers).toHaveLength(1);
    expect(consumers[0][1].trim()).toBe('.tuner-tabbar');
    for (const declaration of ['position: sticky', 'top: var(--tuner-tabbar-top, 0px)', 'z-index: 2', 'overflow-x: auto']) {
      expect(consumers[0][2]).toContain(declaration);
    }
  });
  it('overrides the maximized offset without changing safe-area padding', () => {
    const tabs = rules.find(([ , selector]) => selector.trim() === '.tuner.tuner-maximized .tuner-tabbar');
    expect(tabs[2]).toContain('top: 0;');
    const root = rules.find(([ , selector]) => selector.trim() === '.tuner.tuner-maximized');
    expect(root[2]).toContain('overflow-y: auto;');
    expect(root[2]).toContain('padding: max(12px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));');
  });
  it('prevents the maximized flex scroll container from shrinking and clipping the tabbar', () => {
    const tabs = rules.find(([, selector]) => selector.trim() === '.tuner.tuner-maximized .tuner-tabbar');
    // Independent declarations allow the sticky override and the collapse fix
    // to coexist; an exact body match would incorrectly reject this combination.
    expect(tabs[2]).toContain('top: 0;');
    expect(tabs[2]).toContain('flex-shrink: 0;');
    const root = rules.find(([, selector]) => selector.trim() === '.tuner');
    expect(root[2]).toContain('display: flex;');
    expect(root[2]).toContain('flex-direction: column;');
  });
});
