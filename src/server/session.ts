import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { InventoryDatabase } from '../db/database.js';
import type { Role } from '../domain/types.js';

interface Session {
  token: string;
  role: Role;
  deadline: number | null;
}

const rank: Record<Role, number> = { guest: 0, operator: 1, admin: 2 };

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly db: InventoryDatabase,
    passwords: { operator?: string; admin?: string },
    private readonly now: () => number = Date.now,
    private readonly idleMs: Record<'operator' | 'admin', number> = {
      operator: 300_000,
      admin: 60_000,
    },
    private readonly maxSessions = 1_024,
  ) {
    for (const role of ['operator', 'admin'] as const) {
      const exists = this.db.prepare('SELECT 1 FROM credentials WHERE role=?').get(role);
      if (!exists && !passwords[role])
        throw new Error(
          `Missing required ${role.toUpperCase()}_PASSWORD bootstrap credential for a fresh database`,
        );
    }
    this.ensureCredential('operator', passwords.operator);
    this.ensureCredential('admin', passwords.admin);
  }

  get(token?: string): Session {
    this.prune();
    let session = token ? this.sessions.get(token) : undefined;
    if (!session) {
      session = { token: randomBytes(32).toString('base64url'), role: 'guest', deadline: null };
      if (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.keys().next().value as string | undefined;
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.set(session.token, session);
    }
    return session;
  }

  touch(session: Session): Session {
    if (session.role !== 'guest') session.deadline = this.now() + this.idleMs[session.role];
    return session;
  }

  changeRole(session: Session, target: Role, password?: string): Session {
    if (rank[target] > rank[session.role] && !this.verify(target, password ?? '')) return session;
    session.role = target;
    session.deadline = target === 'guest' ? null : this.now() + this.idleMs[target];
    return session;
  }

  verify(role: Role, password: string): boolean {
    if (role === 'guest') return true;
    const row = this.db
      .prepare('SELECT salt,password_hash FROM credentials WHERE role=?')
      .get(role) as { salt: string; password_hash: string };
    const actual = scryptSync(password, Buffer.from(row.salt, 'hex'), 64);
    return timingSafeEqual(actual, Buffer.from(row.password_hash, 'hex'));
  }

  changePassword(role: 'operator' | 'admin', password: string): void {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    this.db
      .prepare(
        `INSERT INTO credentials(role,salt,password_hash,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(role) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash,updated_at=CURRENT_TIMESTAMP`,
      )
      .run(role, salt.toString('hex'), hash.toString('hex'));
    for (const session of this.sessions.values()) {
      if (session.role === role) {
        session.role = 'guest';
        session.deadline = null;
      }
    }
  }

  private ensureCredential(role: 'operator' | 'admin', password?: string): void {
    const exists = this.db.prepare('SELECT 1 FROM credentials WHERE role=?').get(role);
    if (exists) return;
    if (!password)
      throw new Error(
        `Missing required ${role.toUpperCase()}_PASSWORD bootstrap credential for a fresh database`,
      );
    this.changePassword(role, password);
  }

  private prune(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.role === 'guest' || (session.deadline != null && now >= session.deadline))
        this.sessions.delete(token);
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
}
