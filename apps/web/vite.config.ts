import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// Where the page is served: `/` by default, `/alibi/` on GitHub Pages. Every fetch and asset goes through BASE_URL.
const base = (process.env.ALIBI_BASE ?? '/').replace(/\/?$/, '/');
// The absolute address of the site, for the share image and the canonical link. Left out when it is not set.
const site = process.env.ALIBI_SITE_URL ? process.env.ALIBI_SITE_URL.replace(/\/?$/, '/') : undefined;

const shareTags = (): Plugin => ({
  name: 'alibi-share-tags',
  transformIndexHtml: () =>
    site
      ? [
          { tag: 'link', attrs: { rel: 'canonical', href: site }, injectTo: 'head' },
          { tag: 'meta', attrs: { property: 'og:url', content: site }, injectTo: 'head' },
          { tag: 'meta', attrs: { property: 'og:image', content: `${site}og.png` }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'twitter:image', content: `${site}og.png` }, injectTo: 'head' },
        ]
      : [],
});

// The engine is used from its source, so a fresh clone builds without building packages/core first.
export default defineConfig({
  plugins: [react(), shareTags()],
  base,
  resolve: { alias: { '@alibi/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) } },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
