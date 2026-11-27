import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The longer scenarios move a hand-held clock through nine minutes of requests; give a busy machine room.
  test: { testTimeout: 60000, hookTimeout: 60000 },
});
