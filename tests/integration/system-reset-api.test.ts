import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { createApp } from '../../src/server/app.js';

describe('desktop reset authorization', () => {
  it('is absent from server hosting even when a callback is supplied', async () => {
    const db = openDatabase(':memory:');
    try {
      const reset = vi.fn(async () => 'confirmed' as const);
      const app = createApp({
        database: db,
        adminPassword: 'password',
        serveWeb: false,
        desktopReset: reset,
      });
      await request(app).post('/api/system/reset').expect(404);
      expect(reset).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
  it('requires the launch token and current admin; cancellation and errors preserve data', async () => {
    const db = openDatabase(':memory:');
    const clock = { now: 1000 };
    const reset = vi.fn(async () => 'cancelled' as 'confirmed' | 'cancelled');
    try {
      const app = createApp({
        database: db,
        adminPassword: 'password',
        serveWeb: false,
        accessToken: 'launch',
        now: () => clock.now,
        adminIdleMs: 100,
        desktopReset: reset,
      });
      const agent = request.agent(app);
      await agent.post('/api/system/reset').expect(403);
      await agent.post('/api/system/reset').set('x-mapatz-desktop-token', 'launch').expect(403);
      expect(reset).not.toHaveBeenCalled();
      await agent
        .post('/api/session/role')
        .set('x-mapatz-desktop-token', 'launch')
        .send({ role: 'admin', password: 'password' })
        .expect(200);
      expect(
        (await agent.post('/api/system/reset').set('x-mapatz-desktop-token', 'launch').expect(200))
          .body,
      ).toEqual({ outcome: 'cancelled' });
      reset.mockResolvedValueOnce('confirmed');
      expect(
        (await agent.post('/api/system/reset').set('x-mapatz-desktop-token', 'launch').expect(200))
          .body,
      ).toEqual({ outcome: 'confirmed' });
      reset.mockRejectedValueOnce(new Error('Local confirmation unavailable'));
      await agent.post('/api/system/reset').set('x-mapatz-desktop-token', 'launch').expect(500);
      clock.now += 101;
      await agent.post('/api/system/reset').set('x-mapatz-desktop-token', 'launch').expect(403);
      expect(reset).toHaveBeenCalledTimes(3);
      expect(db.prepare("SELECT 1 FROM credentials WHERE role='admin'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
