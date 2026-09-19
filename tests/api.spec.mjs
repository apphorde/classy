import { test, expect } from '@playwright/test';

const authHeader = { Authorization: `Basic ${process.env.CLASSY_BASIC_AUTH || ''}` };
const baseURL = process.env.CLASSY_BASE_URL || 'https://classy.api.apphor.de';

test('archive API exposes OpenAPI, face filtering, and thumbnails', async ({ request }) => {
  const specResponse = await request.get(`${baseURL}/api`, { headers: authHeader });
  expect(specResponse.ok()).toBeTruthy();
  const spec = await specResponse.json();
  expect(spec.paths['/api/media/{id}/thumbnail']).toBeTruthy();
  expect(spec.paths['/api/media/{id}/faces']).toBeTruthy();
  expect(spec.paths['/api/face-groups']).toBeTruthy();

  const mediaResponse = await request.get(`${baseURL}/api/media?faces=1&limit=1`, { headers: authHeader });
  expect(mediaResponse.ok()).toBeTruthy();
  const media = await mediaResponse.json();
  expect(media.items.length).toBeGreaterThan(0);
  expect(media.items[0].faceCount).toBeGreaterThan(0);

  const thumbnailResponse = await request.get(`${baseURL}${media.items[0].thumbnailUrl}`, { headers: authHeader });
  expect(thumbnailResponse.ok()).toBeTruthy();
  expect(thumbnailResponse.headers()['content-type']).toContain('image/jpeg');

  const groupsResponse = await request.get(`${baseURL}/api/face-groups`, { headers: authHeader });
  expect(groupsResponse.ok()).toBeTruthy();
  expect((await groupsResponse.json()).groups.length).toBeGreaterThan(0);
});
