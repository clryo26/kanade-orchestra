// Admin system helpers split from modules/admin_system.js.

var appState = window.portalRuntimeContext.appState;
var $ = window.portalRuntimeContext.getById;

function sortedPartSettings() {
    return [...(appState.partSettings || [])].sort((a, b) =>
        Number(a.display_order || 9999) - Number(b.display_order || 9999) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function currentPartNames() {
    const configured = sortedPartSettings()
        .map((part) => String(part.name || '').trim())
        .filter(Boolean);
    return configured.length ? configured : window.portalRuntimeContext.DEFAULT_MEMBER_PARTS;
}

function partSelectOptionsHtml(selected = '') {
    return ['<option value="">選択してください</option>']
        .concat(currentPartNames().map((part) => `<option value="${escapeHtml(part)}" ${part === selected ? 'selected' : ''}>${escapeHtml(part)}</option>`))
        .join('');
}

function refreshPartSelectOptions() {
    const portalPart = $('portalPartInput');
    if (portalPart) {
        const selected = portalPart.value;
        portalPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...portalPart.options].some((option) => option.value === selected)) portalPart.value = selected;
    }
    const memberPart = $('memberPart');
    if (memberPart) {
        const selected = memberPart.value;
        memberPart.innerHTML = partSelectOptionsHtml(selected);
        if ([...memberPart.options].some((option) => option.value === selected)) memberPart.value = selected;
    }
}

function partMigrationNames() {
    return [...window.portalRuntimeContext.DEFAULT_MEMBER_PARTS, ...appState.members.map((member) => String(member.part || '').trim())]
        .filter((part, index, array) => part && array.indexOf(part) === index);
}

function sortedVenueSettings() {
    return [...(appState.venueSettings || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ja')
    );
}

function venueSettingsFor(kind) {
    return sortedVenueSettings().filter((venue) => {
        if (kind === 'performance') return venue.for_performance !== false;
        if (kind === 'practice') return venue.for_practice !== false;
        return true;
    });
}

function venueSelectOptionsHtml(kind, selected = '') {
    const normalizedSelected = String(selected || '');
    const venues = venueSettingsFor(kind);
    const options = ['<option value="">選択してください</option>'];
    options.push(...venues.map((venue) => {
        const name = String(venue.name || '');
        return `<option value="${escapeHtml(name)}" ${name === normalizedSelected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
    }));
    if (normalizedSelected && !venues.some((venue) => String(venue.name || '') === normalizedSelected)) {
        options.push(`<option value="${escapeHtml(normalizedSelected)}" selected>${escapeHtml(normalizedSelected)}（未登録会場）</option>`);
    }
    return options.join('');
}

function refreshVenueOptions() {
    const performanceSelect = $('perfVenue');
    if (performanceSelect) {
        performanceSelect.innerHTML = venueSelectOptionsHtml('performance', performanceSelect.value);
    }
    const practiceSelect = $('schedVenue');
    if (practiceSelect) {
        practiceSelect.innerHTML = venueSelectOptionsHtml('practice', practiceSelect.value);
    }
}

function venueInputId(kind) {
    return kind === 'performance' ? 'venuePerformanceName' : 'venuePracticeName';
}

function currentOrgSetting() {
    return (appState.orgSettings || [])[0] || {};
}

function orgShortName() {
    const org = currentOrgSetting();
    return String(
        org.short_name
        || org.shortName
        || org.abbreviation
        || org.short
        || org.organization_abbreviation
        || org.organizationAbbreviation
        || org.name
        || org.organization_name
        || org.organizationName
        || org.organization_name_full
        || org.organizationNameFull
        || '楽団'
    ).trim() || '楽団';
}

function portalTitleText() {
    return `${orgShortName()}ポータル`;
}

function currentConnectionSetting() {
    return (appState.connectionSettings || [])[0] || {};
}
