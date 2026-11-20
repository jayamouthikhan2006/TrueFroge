// Bundles the extension host code (and the provisioning CLI) into dist/, and
// copies ../trueforge-config into dist/trueforge-config so a packaged VSIX is
// self-contained.
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // `vscode` is provided by the extension host at runtime.
  external: ['vscode'],
  // The TrueForge SDK and MCP SDK ship dual ESM/CJS builds; prefer CJS.
  mainFields: ['main', 'module'],
  conditions: ['require', 'node'],
};

const targets = [
  { ...common, entryPoints: [join(here, 'src/extension.ts')], outfile: join(here, 'dist/extension.js') },
  { ...common, entryPoints: [join(here, 'src/cli/provision.ts')], outfile: join(here, 'dist/provision.js'), banner: { js: '#!/usr/bin/env node' } },
];

function copyConfig() {
  const src = join(here, '..', 'trueforge-config');
  const dest = join(here, 'dist', 'trueforge-config');
  if (!existsSync(src)) {
    throw new Error(`trueforge-config not found at ${src}`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

if (watch) {
  copyConfig();
  const contexts = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(targets.map((t) => build(t)));
  copyConfig();
}
