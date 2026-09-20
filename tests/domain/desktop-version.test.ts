import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/desktop-version.mjs');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const run = (args: string[], cwd?: string) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

describe('release tag version', () => {
  it.each([
    ['0.1.2', '0.1.2'],
    ['v2.10.3', '2.10.3'],
  ])('derives %s without dependencies or a package checkout', (tag, version) => {
    const result = run(['validate-tag', tag!], tmpdir());
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });
  it.each([
    '',
    'latest',
    '9007199254740992.1.0',
    'release/0.1.2',
    '01.1.2',
    '1.2',
    '1.2.3.4',
    '1.2.3-beta.1',
    '1.2.3+build',
    'vv1.2.3',
    '1.2.3\n',
  ])('rejects %j', (tag) => {
    expect(run(['validate-tag', tag]).status).not.toBe(0);
  });
  it('stamps only root versions, preserves dependency metadata, and is repeatable', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mapatz-version-'));
    directories.push(cwd);
    mkdirSync(join(cwd, 'scripts'));
    const pkg = {
      name: 'mapatz-inventory',
      version: '0.1.1',
      dependencies: { example: '0.1.1' },
      engines: { node: '>=22.16' },
    };
    const lock = {
      name: pkg.name,
      version: '0.1.1',
      lockfileVersion: 3,
      packages: {
        '': { ...pkg },
        'node_modules/example': { version: '0.1.1', integrity: 'sha512-unchanged' },
      },
    };
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(cwd, 'scripts/desktop-package-lock.json'), JSON.stringify(lock));
    expect(run(['stamp', '0.1.2'], cwd).status).toBe(0);
    const read = (path: string) => readFileSync(join(cwd, path), 'utf8');
    const firstPackage = read('package.json');
    const firstLock = read('scripts/desktop-package-lock.json');
    expect(firstPackage).toContain('"engines": {\n');
    expect(JSON.parse(firstPackage)).toEqual({ ...pkg, version: '0.1.2' });
    expect(JSON.parse(firstLock)).toEqual({
      ...lock,
      version: '0.1.2',
      packages: { ...lock.packages, '': { ...pkg, version: '0.1.2' } },
    });
    expect(run(['stamp', '0.1.2'], cwd).status).toBe(0);
    expect(read('package.json')).toBe(firstPackage);
    expect(read('scripts/desktop-package-lock.json')).toBe(firstLock);
    expect(run(['stamp', 'bad-tag'], cwd).status).not.toBe(0);
    expect(read('package.json')).toBe(firstPackage);
    expect(read('scripts/desktop-package-lock.json')).toBe(firstLock);
    writeFileSync(join(cwd, 'scripts/desktop-package-lock.json'), '{}');
    expect(run(['stamp', '0.1.3'], cwd).status).not.toBe(0);
    expect(read('package.json')).toBe(firstPackage);
  });
});
