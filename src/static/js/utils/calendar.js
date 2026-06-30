function portalIsoDate(value) {
    return value ? new Date(value).toISOString().slice(0, 10) : '';
}
