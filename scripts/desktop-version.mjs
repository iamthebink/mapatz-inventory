import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';

function version(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? ''))
    throw new Error('Expected a stable version such as 0.1.2 (no prerelease or build suffix).');
  if (value.split('.').some((part) => !Number.isSafeInteger(Number(part))))
    throw new Error('Version components exceed the supported integer range.');
  return value;
}

const [command, input, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Unexpected version arguments.');
if (command === 'validate-tag') {
  const tagVersion = input?.startsWith('v') ? input.slice(1) : input;
  process.stdout.write(`${version(tagVersion)}\n`);
} else if (command === 'stamp') {
  const resolved = version(input);
  const packagePath = 'package.json';
  const lockPath = 'scripts/desktop-package-lock.json';
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (!lock.packages?.[''] || lock.name !== pkg.name || lock.packages[''].name !== pkg.name)
    throw new Error('Desktop lockfile root must describe the application package.');
  pkg.version = resolved;
  lock.version = resolved;
  lock.packages[''].version = resolved;
  // Preserve repository formatting so regression checks test the stamped checkout too.
  const { format, resolveConfig } = await import('prettier');
  const options = (await resolveConfig(packagePath)) ?? {};
  const packageText = await format(JSON.stringify(pkg), { ...options, filepath: packagePath });
  const lockText = await format(JSON.stringify(lock), { ...options, filepath: lockPath });
  await writeFile(packagePath, packageText);
  await writeFile(lockPath, lockText);
  process.stdout.write(`Desktop version: ${resolved}\n`);
} else {
  throw new Error('Usage: node scripts/desktop-version.mjs <validate-tag TAG | stamp VERSION>');
}
