function portalIsoDate(value) {
    if (!value) return '';
    if (typeof value === 'string' && portalCalendarDayNumber(value) !== null) return value;
    return formatPortalJstDate(value instanceof Date ? value.getTime() : value);
}
