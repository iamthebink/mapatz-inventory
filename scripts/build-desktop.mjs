import process from 'node:process';
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (Number(process.versions.node.split('.')[0]) !== 24)
  throw new Error(
    'Desktop packaging requires Node 24 LTS (Forge extraction is unreliable on Node 26).',
  );
const stage = 'desktop-stage';
const make = process.argv.includes('--make');
function forge(command, extra = []) {
  execFileSync(
    process.execPath,
    ['node_modules/@electron-forge/cli/dist/electron-forge.js', command, stage, ...extra],
    {
      stdio: 'inherit',
      env: { ...process.env, NODE_INSTALLER: 'npm', npm_config_user_agent: 'npm' },
    },
  );
}
// Makers consume the already tested package; never silently rebuild different release bits.
if (make) {
  if (!existsSync(`${stage}/out`))
    throw new Error('Run desktop:package and test:desktop before desktop:make.');
  forge('make', ['--skip-package']);
  process.exit(0);
}
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
execFileSync(pnpm, ['build'], { stdio: 'inherit', shell: process.platform === 'win32' });
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
cpSync('dist', `${stage}/dist`, { recursive: true });
for (const file of ['preload.cjs', 'setup.html', 'setup.js', 'reset.html', 'reset.js'])
  cpSync(`src/desktop/${file}`, `${stage}/dist/desktop/${file}`);
cpSync('forge.config.cjs', `${stage}/forge.config.cjs`);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(
  `${stage}/package.json`,
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: 'Offline camp inventory',
      author: 'Mapatz',
      main: 'dist/desktop/main.js',
      type: 'module',
      dependencies: pkg.dependencies,
      devDependencies: { electron: pkg.devDependencies.electron },
      config: { forge: './forge.config.cjs' },
    },
    null,
    2,
  ),
);
cpSync('scripts/desktop-package-lock.json', `${stage}/package-lock.json`);
// npm lays out a self-contained production tree, avoiding pnpm symlinks into the checkout.
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' },
);
forge('package');

if (!existsSync(`${stage}/out`))
  throw new Error('Forge produced no artifact; use Node 24 LTS for desktop builds.');
