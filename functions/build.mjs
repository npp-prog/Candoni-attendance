// Bundles the functions source together with ../shared into a single CommonJS
// file. npm dependencies stay external and are installed by Cloud Build.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'lib/index.js',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
