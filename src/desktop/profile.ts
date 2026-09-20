import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export async function profilePort(directory: string): Promise<number> {
  mkdirSync(directory, { recursive: true });
  const filename = join(directory, 'profile.json');
  if (existsSync(filename)) {
    const value = JSON.parse(readFileSync(filename, 'utf8')) as {
      port: number;
      initialized?: boolean;
    };
    if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535)
      throw new Error(
        'Invalid profile.json. Restore the original profile; do not reset the profile.',
      );
    if (value.initialized && !existsSync(join(directory, 'inventory.sqlite')))
      throw new Error(
        'Existing profile database is missing. Restore the database; no replacement was created.',
      );
    return value.port;
  }
  // An existing database with a missing origin must never receive an arbitrary new origin.
  if (existsSync(join(directory, 'inventory.sqlite')))
    throw new Error(
      'Missing profile.json for existing data. Restore profile.json from your backup.',
    );
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No loopback port'));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  writeFileSync(`${filename}.tmp`, JSON.stringify({ port }), { mode: 0o600 });
  renameSync(`${filename}.tmp`, filename);
  return port;
}

export function markProfileInitialized(directory: string): void {
  const filename = join(directory, 'profile.json');
  const value = JSON.parse(readFileSync(filename, 'utf8')) as {
    port: number;
    initialized?: boolean;
  };
  writeFileSync(`${filename}.tmp`, JSON.stringify({ ...value, initialized: true }), {
    mode: 0o600,
  });
  renameSync(`${filename}.tmp`, filename);
}
