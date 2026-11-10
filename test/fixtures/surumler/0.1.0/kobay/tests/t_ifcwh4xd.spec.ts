import { test, expect } from './_fixture';
test("Login heading is wrong on purpose", async ({ page }) => {
  await test.step("0: Open the login page", async () => {
    await page.goto('http://127.0.0.1:47391/login');
  });
  await test.step("1: See the welcome heading", async () => {
    await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible({ timeout: 3000 });
  });
});
