import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { createApp } from '../../src/server/index.js';

describe('radio API', () => {
  it('allows operator custody and loss actions, restricts count, and rejects obsolete edits', async () => {
    const db = openDatabase(':memory:');
    const agent = request.agent(
      createApp({ database: db, adminPassword: 'admin-pass', serveWeb: false }),
    );
    const initial = (await agent.get('/api/radios').expect(200)).body;
    expect(initial.count).toBe(0);
    await agent
      .put('/api/radios/count')
      .send({ count: 2, generation: initial.generation })
      .expect(403);
    await agent
      .post('/api/session/role')
      .send({ role: 'admin', password: 'admin-pass' })
      .expect(200);
    const fleet = (
      await agent
        .put('/api/radios/count')
        .send({ count: 2, generation: initial.generation })
        .expect(200)
    ).body;
    await agent.post('/api/session/role').send({ role: 'operator' }).expect(200);
    await agent
      .put('/api/radios/count')
      .send({ count: 0, generation: fleet.generation })
      .expect(403);
    await agent
      .put('/api/radios/1/custody')
      .send({ generation: fleet.generation, holder: 'MDA', team: 'Medics' })
      .expect(200);
    await agent
      .put('/api/radios/2/custody')
      .send({ generation: fleet.generation, holder: 'MDA', team: '' })
      .expect(200);
    await agent
      .put('/api/radios/2/custody')
      .send({ generation: fleet.generation, holder: 'MDA volunteer' })
      .expect(200);
    await agent.post('/api/radios/1/lost').send({ generation: fleet.generation }).expect(200);
    await agent
      .put('/api/radios/1/custody')
      .send({ generation: fleet.generation, holder: 'Other', team: '' })
      .expect(409);
    await agent.post('/api/radios/1/return').send({ generation: fleet.generation }).expect(409);
    await agent.post('/api/radios/1/lost').send({ generation: fleet.generation }).expect(409);
    await agent.post('/api/radios/1/found').send({ generation: fleet.generation }).expect(200);
    await agent.post('/api/radios/1/return').send({ generation: fleet.generation }).expect(200);
    await agent
      .put('/api/radios/2/custody')
      .send({ generation: fleet.generation, holder: ' ', team: '' })
      .expect(400);
    const before = (await agent.get('/api/radios').expect(200)).body;
    expect(before.radios[0]).toMatchObject({ holder: 'צוללת', team: '', lost: false });
    expect(before.radios[1]).toMatchObject({ holder: 'MDA volunteer', team: '', lost: false });
    expect(db.prepare('SELECT COUNT(*) count FROM borrowers').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({ count: 0 });
    await agent
      .post('/api/session/role')
      .send({ role: 'admin', password: 'admin-pass' })
      .expect(200);
    const unchanged = (
      await agent
        .put('/api/radios/count')
        .send({ count: 2, generation: fleet.generation })
        .expect(200)
    ).body;
    expect(unchanged).toEqual(before);
    await agent
      .put('/api/radios/count')
      .send({ count: -1, generation: fleet.generation })
      .expect(400);
    await agent
      .put('/api/radios/count')
      .send({ count: 1.5, generation: fleet.generation })
      .expect(400);
    const reset = (
      await agent
        .put('/api/radios/count')
        .send({ count: 3, generation: fleet.generation })
        .expect(200)
    ).body;
    expect(reset.radios).toEqual(
      [1, 2, 3].map((number) => ({ number, holder: 'צוללת', team: '', lost: false })),
    );
    await agent
      .put('/api/radios/1/custody')
      .send({ generation: fleet.generation, holder: 'Stale', team: '' })
      .expect(409);
    expect((await agent.get('/api/radios').expect(200)).body).toEqual(reset);
    db.close();
  });
});
