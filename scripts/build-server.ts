import { build } from 'esbuild';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const entries = [
  'src/index.ts',
  'src/bin/reviewer.ts',
  'src/server/app.ts',
  'src/shared/guarantee-review.ts',
  'src/shared/workplan.ts',
];

await build({
  entryPoints: entries,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  outbase: 'src',
  external: ['@treeseed/sdk', '@treeseed/sdk/*', '@treeseed/cli', 'react', 'react-dom', 'yaml'],
});

const bin = resolve('dist/bin/reviewer.js');
if (existsSync(bin)) chmodSync(bin, 0o755);

const packageJson = resolve('package.json');
const outPackageJson = resolve('dist/package.json');
mkdirSync(dirname(outPackageJson), { recursive: true });
copyFileSync(packageJson, outPackageJson);
