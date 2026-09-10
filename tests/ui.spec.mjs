import { test, expect } from '@playwright/test';

const credentials = Buffer.from(process.env.CLASSY_BASIC_AUTH || '', 'base64').toString().split(':');
test.use({ httpCredentials: { username: credentials[0], password: credentials.slice(1).join(':') } });

test('authenticated archive UI renders indexed media', async ({ page }) => {
  page.on('console', (message) => console.log(`CONSOLE ${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => console.log(`PAGEERROR: ${error.message}`));
  page.on('requestfailed', (request) => console.log(`REQUESTFAILED ${request.url()}: ${request.failure()?.errorText}`));
  await page.addInitScript(() => { window.name = 'debug'; });
  await page.goto(process.env.CLASSY_BASE_URL || 'https://classy.api.apphor.de/', { waitUntil: 'networkidle' });
  await expect(page.getByText('Every file has a')).toBeVisible();
  await expect(page.locator('article')).not.toHaveCount(0);
});
