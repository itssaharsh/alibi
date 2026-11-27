import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COLLECTOR_CONFIG, HELPER_SNIPPET, START_COMMAND } from './copy';

const readme = readFileSync(fileURLToPath(new URL('../../../../README.md', import.meta.url)), 'utf8');

describe('"Plug it in" says what the README says', () => {
  it('the start command is the README\'s own command', () => {
    expect(readme).toContain(`\n${START_COMMAND}\n`);
  });
  it('the collector block and the helper snippet appear in the README unchanged', () => {
    expect(readme).toContain(COLLECTOR_CONFIG);
    expect(readme).toContain(HELPER_SNIPPET);
  });
});
