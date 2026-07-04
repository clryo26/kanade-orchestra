(function (globalObj) {
    const dates = typeof module !== 'undefined' && module.exports
        ? require('./testable/dates.js')
        : (globalObj.FrontendTestableDates || {});
    const pieces = typeof module !== 'undefined' && module.exports
        ? require('./testable/pieces.js')
        : (globalObj.FrontendTestablePieces || {});
    const formatting = typeof module !== 'undefined' && module.exports
        ? require('./testable/formatting.js')
        : (globalObj.FrontendTestableFormatting || {});
    const validation = typeof module !== 'undefined' && module.exports
        ? require('./testable/validation.js')
        : (globalObj.FrontendTestableValidation || {});
    const apiRuntime = typeof module !== 'undefined' && module.exports
        ? require('./testable/api_runtime.js')
        : {};

    const api = {
        ...dates,
        ...pieces,
        ...formatting,
        ...validation,
        ...apiRuntime,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalObj.FrontendTestableLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
