import { expect, test } from '@playwright/test';
import worker from '../../src/worker.js';

test('an old board notification opens Home without the board parameters', async () => {
  const origin = 'https://app.example.test';
  const response = await worker.fetch(new Request(origin + '/control-room/progress/board/demo?mode=live'), {
    CARR: { fetch: () => new Response(null) },
  });
  expect(response.status).toBe(308);
  expect(response.headers.get('location')).toBe(origin + '/');
});
