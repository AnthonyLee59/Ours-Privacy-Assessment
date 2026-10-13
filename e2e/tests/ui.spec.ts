import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PHOTO = 'http://img.test:4599/photo.jpg';

/** Fail the test on any browser error: uncaught exceptions or CSP violations (logged as console errors). */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // Expected 4xx/5xx API answers are logged by Chrome as failed resources; those are not app errors.
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}

async function processImage(page: Page, url: string, setup?: () => Promise<void>) {
  await page.goto('/');
  await page.getByLabel('Image URL').fill(url);
  await setup?.();
  await page.getByRole('button', { name: 'Process image' }).click();
}

test('resizes and converts an image end to end', async ({ page }) => {
  const errors = watchForErrors(page);
  await processImage(page, PHOTO, async () => {
    await page.getByLabel(/^Width/).fill('400');
    await page.getByLabel('Format').selectOption('webp');
  });

  const processed = page.getByRole('region', { name: 'Processed' });
  const original = page.getByRole('region', { name: 'Original' });
  await expect(processed).toContainText('400 × 300');
  await expect(processed).toContainText('WEBP');
  await expect(original).toContainText('800 × 600');
  await expect(original).toContainText('JPEG');

  // Both images really decoded: the blob from the API and the original via the UI's CSP.
  await expect
    .poll(() => processed.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(400);
  await expect
    .poll(() => original.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(800);

  await expect(page.getByLabel('Request URL')).toHaveValue(
    /\/v1\/process\?url=http%3A%2F%2Fimg\.test%3A4599%2Fphoto\.jpg&width=400&format=webp$/,
  );
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute(
    'download',
    'processed.webp',
  );
  expect(errors).toEqual([]);
});

test('the displayed request URL works on its own and the curl snippet is copyable', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByLabel('Image URL').fill(PHOTO);
  await page.getByLabel(/^Height/).fill('120');

  const url = await page.getByLabel('Request URL').inputValue();
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()['x-output-height']).toBe('120');

  await page.getByRole('button', { name: 'Copy curl' }).click();
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(`curl -fo processed.jpg '${url}'`);
});

test('validation problems are shown inline before anything is sent', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Image URL').fill(PHOTO);
  await page.getByLabel(/^Width/).fill('0');
  await expect(page.getByText('width must be between 1 and 4000')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process image' })).toBeDisabled();
});

test('a blocked internal URL is explained, not silently failed', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sample: Blocked: cloud metadata' }).click();
  await page.getByRole('button', { name: 'Process image' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('URL_NOT_ALLOWED');
  await expect(alert).toContainText('169.254.169.254');
  await expect(alert).toContainText('Request ID');
});

test('a non-image source gets a clear unsupported-file error', async ({ page }) => {
  await processImage(page, 'http://img.test:4599/page.html');
  await expect(page.getByRole('alert')).toContainText('UNSUPPORTED_MEDIA_TYPE');
  await expect(page.getByRole('alert')).toContainText('Link directly to the image file');
});

test('transparent PNGs keep their alpha channel', async ({ page }) => {
  await processImage(page, 'http://img.test:4599/logo.png', async () => {
    await page.getByLabel(/^Width/).fill('100');
  });
  const processed = page.getByRole('region', { name: 'Processed' });
  await expect(processed).toContainText('100 × 100');
  await expect(processed).toContainText('PNG');
});

test('interactive API docs render under their CSP', async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto('/docs/');
  await expect(page.getByRole('heading', { name: /Image Processing API/ })).toBeVisible();
  await expect(page.getByText('/v1/process').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('large images are scaled to fit their panels, never overflowing', async ({ page }) => {
  // 800x600 is wider than either panel at desktop and mobile sizes.
  await processImage(page, PHOTO);
  for (const name of ['Original', 'Processed']) {
    const panel = page.getByRole('region', { name });
    const img = panel.getByRole('img');
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(800);
    // Compare with the visible panel: the panel clips overflow, so a too-wide image gets cut off.
    const frame = (await panel.boundingBox())!;
    const box = (await img.boundingBox())!;
    expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(frame.x);
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(
      frame.x + frame.width + 0.5,
    );
  }
});
