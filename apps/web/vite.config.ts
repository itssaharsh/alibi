import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The engine is used from its source, so a fresh clone builds without building packages/core first.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: { '@alibi/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) } },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
