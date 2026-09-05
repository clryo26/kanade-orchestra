const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Practice attendance', () => {
  test('practice schedule has four attendance choices and hides removed menu items', async ({ page }) => {
    await installPortalApiMocks(page, {
      permission: '一般',
      bootstrapOverrides: {
        members: [
          { id: 1, name: '団員テスト', part: 'Violin', permission: '一般', password_set: true },
          { id: 2, name: '遅刻花子', part: 'Viola', permission: '一般', password_set: true },
          { id: 3, name: '早退次郎', part: 'Cello', permission: '一般', password_set: true },
          { id: 4, name: '欠席三郎', part: 'Flute', permission: '一般', password_set: true },
          { id: 5, name: '未登録四郎', part: 'Oboe', permission: '一般', password_set: true },
        ],
        schedules: [{ id: 101, date: '2099-08-20', start_time: '13:00', end_time: '16:30', venue: '練習場' }],
        extras: {
          absences: [
            { id: 1, schedule_id: 101, member_id: 1, name: '団員テスト', status: 'present' },
            { id: 2, schedule_id: 101, member_id: 2, name: '遅刻花子', status: 'late', planned_time: '14:00' },
            { id: 3, schedule_id: 101, member_id: 3, name: '早退次郎', status: 'leave_early', planned_time: '16:00' },
            { id: 4, schedule_id: 101, member_id: 4, name: '欠席三郎', status: 'absent' },
          ],
        },
      },
    });
    await page.goto('/');
    await loginAsMember(page);

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-tab="member-schedule"]').click();
    const form = page.locator('[data-attendance-form]');
    await expect(form.getByLabel('出席')).toBeChecked();
    for (const label of ['出席', '欠席', '遅刻', '早退']) await expect(form.getByLabel(label)).toHaveCount(1);

    await expect(page.locator('#memberScheduleTab')).toContainText('練習可能時間');
    await expect(page.locator('#memberScheduleTab')).not.toContainText('13:00 - 16:30');
    await expect(page.locator('#memberScheduleTab')).not.toContainText('練習場');
    await page.click('#portalDrawerToggle');
    await expect(page.locator('#portalDrawerMenu').getByRole('button', { name: '出欠確認' })).toHaveCount(0);
  });
});
