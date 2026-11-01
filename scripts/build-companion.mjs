import { build } from 'esbuild';
await build({ entryPoints: ['companion/src/main.cjs'], outfile: 'companion/build/main.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'bufferutil', 'utf-8-validate'], sourcemap: false });
await build({ entryPoints: ['companion/src/preload.cjs'], outfile: 'companion/build/preload.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: false });
console.log('Companion main/preload built. Packaging uses explicit files; host configuration is excluded.');
