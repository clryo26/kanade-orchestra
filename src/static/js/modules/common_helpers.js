// Frontend split: extracted from main.js.
// common_helpers.js now stays as a thin compatibility loader.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

// ログイン画面に必要な最小設定だけ先読みする。

// 団員表示名を統一形式（姓 + 旧姓 + 名）で作る。
// memberDisplayName moved to feature module.

// canManageRecordings moved to feature module.

// scheduleTimeLabel moved to feature module.

// scheduleAvailableLabel moved to feature module.

// scheduleCalendarTitle moved to feature module.

// scheduleCalendarDetails moved to feature module.

// googleCalendarUrlForSchedule moved to feature module.

// openGoogleCalendarForSchedule moved to feature module.

// scheduleToIcsEvent moved to feature module.

// saveMember moved to feature module.

// selectMember moved to feature module.

// deleteMember moved to feature module.

// clearMemberForm moved to feature module.

// syncMemberPermissionFields moved to feature module.

// memberKanaName moved to feature module.

// sortedMembersByPartAndKana moved to feature module.

// renderMembers moved to feature module.

// schedulePerformanceLabel moved to feature module.

// schedulePerformanceLabel moved to feature module.

// renderMemberExtraViews moved to feature module.

// 団員向けタブは 1 つずつ個別描画せず、この関数からまとめて再描画する。
// 重い一覧は options で抑制でき、初期表示時の体感速度を落とさないようにしている。
// renderMemberExtraViews moved to feature module.

// Common helpers were split to sub-files.
