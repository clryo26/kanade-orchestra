const { expect } = require('@playwright/test');

function attachErrorMonitor(page) {
  const pageErrors = [];
  const consoleErrors = [];

  page.on('pageerror', (err) => {
    pageErrors.push(String(err && err.message ? err.message : err));
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  function assertNoClientErrors() {
    expect(pageErrors, `pageerror detected: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console error detected: ${consoleErrors.join(' | ')}`).toEqual([]);
  }

  return {
    assertNoClientErrors,
  };
}

module.exports = {
  attachErrorMonitor,
};
