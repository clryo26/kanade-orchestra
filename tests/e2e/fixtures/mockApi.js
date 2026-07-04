const { BOOTSTRAP_DATA, PART_SETTINGS, ORG_SETTINGS, SNS_SETTINGS } = require('./mockData');

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') {
    return target;
  }
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value;
      continue;
    }
    if (value && typeof value === 'object') {
      const base = target[key] && typeof target[key] === 'object' ? target[key] : {};
      target[key] = deepMerge(base, value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

function authResponse(permission = '一般') {
  const isAdmin = permission === '管理者' || permission === 'システム管理者';
  return {
    authenticated: true,
    permission,
    member_id: 1,
    member_name: isAdmin ? '管理者テスト' : '団員テスト',
    member_part: 'Violin',
    is_recording_manager: isAdmin,
    is_sheet_manager: isAdmin,
  };
}

async function fulfillJson(route, payload, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload),
  });
}

async function installPortalApiMocks(page, options = {}) {
  const permission = options.permission || '一般';
  const bootstrapData = deepMerge(JSON.parse(JSON.stringify(BOOTSTRAP_DATA)), options.bootstrapOverrides || {});

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/revision') {
      return fulfillJson(route, { cloudRunRevision: 'test-revision' });
    }

    if (path === '/api/extra/part_settings' || path === '/api/extra/org_settings' || path === '/api/extra/sns_settings') {
      if (path.endsWith('/part_settings')) return fulfillJson(route, PART_SETTINGS);
      if (path.endsWith('/org_settings')) return fulfillJson(route, ORG_SETTINGS);
      return fulfillJson(route, SNS_SETTINGS);
    }

    if (path === '/api/auth/portal-login' && method === 'POST') {
      return fulfillJson(route, authResponse(permission));
    }

    if (path.startsWith('/api/auth/devices/')) {
      return fulfillJson(route, {
        authenticated: true,
        device: {
          member_id: 1,
          member_name: permission === '管理者' ? '管理者テスト' : '団員テスト',
          member_part: 'Violin',
          permission,
          is_recording_manager: permission !== '一般',
          is_sheet_manager: permission !== '一般',
        },
      });
    }

    if (path === '/api/auth/devices') {
      return fulfillJson(route, []);
    }

    if (path === '/api/bootstrap-lite' || path === '/api/bootstrap-core' || path === '/api/bootstrap') {
      return fulfillJson(route, bootstrapData);
    }

    if (path === '/api/system/access-logs') {
      return method === 'POST' ? fulfillJson(route, { ok: true }) : fulfillJson(route, []);
    }

    if (path.startsWith('/api/recordings/play/')) {
      return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: '' });
    }

    if (path.startsWith('/api/sheets/view/')) {
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: '' });
    }

    // Fallback to prevent UI crashes in smoke tests.
    return fulfillJson(route, []);
  });
}

module.exports = { installPortalApiMocks };
