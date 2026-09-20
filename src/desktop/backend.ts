import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { openDatabase } from '../db/database.js';
import { createApp } from '../server/app.js';
import { SessionStore } from '../server/session.js';
import { protectDatabase, validateInitializedDatabase } from './database-safety.js';

const parent = process.parentPort;
if (!parent) throw new Error('Backend requires Electron utility process');
let db: ReturnType<typeof openDatabase> | undefined;
let server: Server | undefined;
let shuttingDown = false;
const sockets = new Set<Socket>();
const activeRequests = new Map<Socket, number>();
let settings: { directory: string; port: number; token: string };
function listen() {
  if (!db) throw new Error('Database not open');
  const app = createApp({ database: db, accessToken: settings.token });
  server = createServer((request, response) => {
    if (shuttingDown) {
      response.writeHead(503, { Connection: 'close' });
      response.end();
      return;
    }
    const socket = request.socket;
    activeRequests.set(socket, (activeRequests.get(socket) ?? 0) + 1);
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      const remaining = (activeRequests.get(socket) ?? 1) - 1;
      if (remaining > 0) activeRequests.set(socket, remaining);
      else {
        activeRequests.delete(socket);
        if (shuttingDown) socket.end();
      }
    };
    response.once('finish', complete);
    response.once('close', complete);
    app(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      activeRequests.delete(socket);
    });
  });
  server.once('listening', () => parent!.postMessage({ type: 'ready' }));
  server.on('error', (error) => parent!.postMessage({ type: 'failure', message: error.message }));
  server.listen(settings.port, '127.0.0.1');
}
parent.on('message', ({ data }) => {
  try {
    if (data.type === 'start') {
      settings = data;
      const filename = join(settings.directory, 'inventory.sqlite');
      const profile = JSON.parse(
        readFileSync(join(settings.directory, 'profile.json'), 'utf8'),
      ) as { initialized?: boolean };
      if (profile.initialized) validateInitializedDatabase(filename);
      protectDatabase(filename, join(settings.directory, 'backups'));
      db = openDatabase(filename);
      if (!db.prepare("SELECT 1 FROM credentials WHERE role='admin'").get())
        parent!.postMessage({ type: 'setup' });
      else listen();
    } else if (data.type === 'password' && db && !server) {
      if (
        typeof data.password !== 'string' ||
        data.password.length < 8 ||
        data.password.length > 256
      )
        throw new Error('Password must contain 8–256 characters');
      new SessionStore(db, data.password);
      listen();
    } else if (data.type === 'stop') {
      if (shuttingDown) return;
      shuttingDown = true;
      parent!.postMessage({
        type: 'diagnostic',
        message: `Backend stop received; listening=${server?.listening}`,
      });
      server?.getConnections((_error, count) =>
        parent!.postMessage({ type: 'diagnostic', message: `Backend open connections=${count}` }),
      );
      const finish = () => {
        parent!.postMessage({ type: 'diagnostic', message: 'Backend HTTP drain complete' });
        db?.close();
        parent!.postMessage({ type: 'diagnostic', message: 'Backend database closed' });
        process.exit(0);
      };
      if (server) {
        server.close(finish);
        // Node's idle-connection closer excludes sockets still parsing incomplete headers.
        // They have not entered the app and cannot own a pending command. Drain accepted
        // requests normally; close every other socket so window close cannot strand a backend.
        for (const socket of sockets) if (!activeRequests.has(socket)) socket.destroy();
        server.closeIdleConnections();
      } else finish();
    }
  } catch (error) {
    parent!.postMessage({
      type: 'failure',
      message: error instanceof Error ? error.message : 'Backend failed',
    });
  }
});
