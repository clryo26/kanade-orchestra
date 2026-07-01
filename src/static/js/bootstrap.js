import { createStore } from './store.js';
import { createRouter } from './router.js';

// Compatibility bootstrap that can coexist with existing main.js/app.js entrypoints.
export function bootstrapPortal() {
    const store = createStore();
    const router = createRouter(store);
    return { store, router };
}

window.okePortalBootstrap = window.okePortalBootstrap || bootstrapPortal;
