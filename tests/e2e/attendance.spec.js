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
    await page.setViewportSize({ width: 390, height: 844 });
    await forms.nth(0).getByLabel('遅刻').check();
    const mobileLayout = await forms.nth(0).evaluate((form) => {
      const radioBox = (value) => form.querySelector(`input[value="${value}"]`).closest('.form-check').getBoundingClientRect();
      const box = (selector) => form.querySelector(selector).getBoundingClientRect();
      return {
        present: radioBox('present'),
        absent: radioBox('absent'),
        late: radioBox('late'),
        early: radioBox('leave_early'),
        time: box('[data-attendance-time-row]'),
      };
    });
    expect(mobileLayout.present.top).toBe(mobileLayout.absent.top);
    expect(mobileLayout.late.left).toBeLessThan(mobileLayout.early.left);
    expect(mobileLayout.early.left).toBeLessThan(mobileLayout.time.left);
    expect(mobileLayout.late.top).toBeGreaterThan(mobileLayout.present.top);
    expect(mobileLayout.early.top).toBeGreaterThan(mobileLayout.present.top);
    expect(mobileLayout.time.top).toBeGreaterThan(mobileLayout.present.top);
    const scheduleCard = page.locator('.schedule-card').filter({ hasText: '練習場' }).first();
    await expect(scheduleCard.getByRole('tab', { name: '出席 3名' })).toBeVisible();
    await scheduleCard.getByRole('tab', { name: '欠席 1名' }).click();
    await expect(scheduleCard).toContainText('欠席三郎');

    await page.click('#portalDrawerToggle');
    await page.locator('#portalDrawerMenu').getByRole('button', { name: '出欠確認' }).click();
    const overview = page.locator('#memberAbsenceInfo .attendance-overview').filter({ hasText: '2099/08/20' });
    await expect(page.locator('#memberAbsenceInfo')).not.toContainText('過去の練習場');
    await expect(overview.getByRole('tab', { name: '出席 3名' })).toBeVisible();
    await overview.getByRole('tab', { name: '出席 3名' }).click();
    await expect(overview.getByText('Viola', { exact: true })).toBeVisible();
    await expect(overview).toContainText('遅刻花子（遅刻 14:00）');
    await expect(overview).toContainText('早退次郎（早退 16:00）');
    await overview.getByRole('tab', { name: '欠席 1名' }).click();
    await expect(overview).toContainText('Cello');
    await expect(overview).toContainText('欠席三郎');
    await expect(overview).not.toContainText('遅刻花子');
    await overview.getByRole('tab', { name: '未登録 1名' }).click();
    await expect(overview).toContainText('未登録四郎');
    await expect(overview).not.toContainText('欠席三郎');
  });
});
