import { test, expect } from '@playwright/test';

const credentials = Buffer.from(process.env.CLASSY_BASIC_AUTH || '', 'base64').toString().split(':');
test.use({ httpCredentials: { username: credentials[0], password: credentials.slice(1).join(':') } });

test('authenticated archive UI renders indexed media', async ({ page }) => {
  page.on('console', (message) => console.log(`CONSOLE ${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => console.log(`PAGEERROR: ${error.message}`));
  page.on('requestfailed', (request) => console.log(`REQUESTFAILED ${request.url()}: ${request.failure()?.errorText}`));
  await page.addInitScript(() => { window.name = 'debug'; });
  await page.goto(process.env.CLASSY_BASE_URL || 'https://classy.api.apphor.de/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('link', { name: 'Classy home' })).toBeVisible();
  await expect(page.locator('article')).not.toHaveCount(0);
  await expect(page.locator('lucide-icon')).toHaveCount(5);
  await page.locator('article').first().click();
  await expect(page.getByRole('button', { name: 'Previous file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to archive' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
});
