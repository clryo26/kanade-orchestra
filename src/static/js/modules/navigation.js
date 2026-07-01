// Frontend split: extracted from main.js.
// navigation.js now stays as a thin compatibility loader.
// Actual navigation logic lives in modules/navigation/*.js.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// setupMemberManagerTabs moved to feature module.
// isExtraRestrictedMemberTab moved to feature module.
// visibleMemberMenuItems moved to feature module.
