import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { InventoryDatabase } from '../db/database.js';
import type { Role } from '../domain/types.js';

interface Session {
  token: string;
  role: Role;
  deadline: number | null;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly db: InventoryDatabase,
    adminPassword?: string,
    private readonly now: () => number = Date.now,
    private readonly adminIdleMs = 600_000,
    private readonly maxSessions = 1_024,
  ) {
    this.ensureCredential(adminPassword);
  }

  get(token?: string): Session {
    this.prune();
    let session = token ? this.sessions.get(token) : undefined;
    if (!session) {
      session = { token: randomBytes(32).toString('base64url'), role: 'operator', deadline: null };
      if (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.keys().next().value as string | undefined;
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.set(session.token, session);
    }
    return session;
  }

  touch(session: Session): Session {
    if (session.role === 'admin') session.deadline = this.now() + this.adminIdleMs;
    return session;
  }

  changeRole(session: Session, target: Role, password?: string): Session {
    if (target === 'admin' && session.role !== 'admin' && !this.verify(password ?? ''))
      return session;
    session.role = target;
    session.deadline = target === 'admin' ? this.now() + this.adminIdleMs : null;
    return session;
  }

  verify(password: string): boolean {
    const row = this.db
      .prepare('SELECT salt,password_hash FROM credentials WHERE role=?')
      .get('admin') as { salt: string; password_hash: string };
    const actual = scryptSync(password, Buffer.from(row.salt, 'hex'), 64);
    return timingSafeEqual(actual, Buffer.from(row.password_hash, 'hex'));
  }

  changePassword(password: string): void {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    this.db
      .prepare(
        `INSERT INTO credentials(role,salt,password_hash,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(role) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash,updated_at=CURRENT_TIMESTAMP`,
      )
      .run('admin', salt.toString('hex'), hash.toString('hex'));
    for (const session of this.sessions.values()) {
      if (session.role === 'admin') {
        session.role = 'operator';
        session.deadline = null;
      }
    }
  }

  private ensureCredential(password?: string): void {
    const exists = this.db.prepare('SELECT 1 FROM credentials WHERE role=?').get('admin');
    if (exists) return;
    if (!password)
      throw new Error('Missing required ADMIN_PASSWORD bootstrap credential for a fresh database');
    this.changePassword(password);
  }

  private prune(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.role === 'admin' && session.deadline != null && now >= session.deadline) {
        session.role = 'operator';
        session.deadline = null;
      }
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
}
