const { test, expect } = require('@playwright/test');
const { installPortalApiMocks } = require('./fixtures/mockApi');

async function loginAsMember(page) {
  await page.fill('#portalNameInput', '団員テスト');
  await page.selectOption('#portalPartInput', { label: 'Violin' });
  await page.fill('#portalPasswordInput', 'dummy-pass');
  await page.click('#portalLoginBtn');
}

test.describe('Practice attendance', () => {
  test('shows registration state and filters overview tabs by grouped members', async ({ page }) => {
    await installPortalApiMocks(page, {
      permission: '一般',
      bootstrapOverrides: {
        members: [
          { id: 1, name: '団員テスト', part: 'Violin', permission: '一般', password_set: true },
          { id: 2, name: '遅刻花子', part: 'Viola', permission: '一般', password_set: true },
          { id: 3, name: '早退次郎', part: 'Viola', permission: '一般', password_set: true },
          { id: 4, name: '欠席三郎', part: 'Cello', permission: '一般', password_set: true },
          { id: 5, name: '未登録四郎', part: 'Cello', permission: '一般', password_set: true },
        ],
        schedules: [
          { id: 100, date: '2000-08-20', start_time: '13:00', end_time: '16:30', venue: '過去の練習場' },
          { id: 101, date: '2099-08-20', start_time: '13:00', end_time: '16:30', venue: '練習場' },
          { id: 102, date: '2099-08-27', start_time: '13:00', end_time: '16:30', venue: '次回練習場' },
        ],
        extras: { absences: [
          { id: 1, schedule_id: 101, member_id: 1, name: '団員テスト', status: 'present' },
          { id: 2, schedule_id: 101, member_id: 2, name: '遅刻花子', status: 'late', planned_time: '14:00' },
          { id: 3, schedule_id: 101, member_id: 3, name: '早退次郎', status: 'leave_early', planned_time: '16:00' },
          { id: 4, schedule_id: 101, member_id: 4, name: '欠席三郎', status: 'absent' },
        ] },
      },
    });
    await page.goto('/');
    await loginAsMember(page);
    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu [data-home-tab="member-schedule"]').click();
    const forms = page.locator('[data-attendance-form]');
    await expect(forms.nth(0).getByLabel('出席')).toBeChecked();
    await expect(forms.nth(0).locator('[data-attendance-save]')).toHaveText('変更');
    await expect(forms.nth(1).locator('[data-attendance-save]')).toHaveText('登録');

    const scheduleCard = page.locator('.schedule-card').first();
    await expect(scheduleCard).toContainText('2099/08/20');
    await expect(scheduleCard).not.toContainText('13:00 - 16:30');
    await expect(scheduleCard).not.toContainText('練習場');
    await expect(scheduleCard.getByRole('tab', { name: '出席 3名' })).toBeVisible();
    await scheduleCard.getByRole('tab', { name: '欠席 1名' }).click();
    await expect(scheduleCard).toContainText('欠席三郎');
    await expect(scheduleCard.locator(':scope > .schedule-main-line:not(.schedule-date-line)')).toHaveCount(0);
    await expect(page.locator('#memberScheduleTab')).toContainText('練習可能時間');

    await page.click('#portalDrawerToggle');
    await expect(page.locator('#portalDrawerMenu').getByRole('button', { name: '出欠確認' })).toHaveCount(0);
  });
});
