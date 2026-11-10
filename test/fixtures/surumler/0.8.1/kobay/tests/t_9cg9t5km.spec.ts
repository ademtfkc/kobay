import { test, expect } from './_fixture';
test("Login page shows its heading", async ({ page }) => {
  await test.step("0: Open the login page", async () => {
    await page.goto('http://127.0.0.1:47391/login');
  });
  await test.step("1: See the login heading", async () => {
    await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 3000 });
  });
});
