function portalApiErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || '');
}
