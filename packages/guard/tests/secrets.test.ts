import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feedCrossing, play } from './drive.js';
import { buildRun, START } from './fixtures.js';
import { ADMIN_KEY, CONTROL_TOKEN, ENV_KEY, FakeFlagsmith, SECRETS, filesUnder, harness, listen, tempDir, type Harness } from './helpers.js';
import { createLogger, makeRedactor } from '../src/log.js';

let fake: FakeFlagsmith;
let h: Harness;

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
});

afterEach(async () => {
  await h.service.stop();
  await fake.stop();
});

describe('secrets', () => {
  it('never reach a log line, a response, the state, a run file or a record', async () => {
    const dir = tempDir();
    const file = join(dir, 'runs', 'secret.jsonl');
    h = harness(fake, START, { ALIBI_RECORD: file, ALIBI_CONTROL_TOKEN: CONTROL_TOKEN, ALIBI_SWITCH_OFF: 'rollout-zero', FLAGSMITH_FEATURE_HEALTH_URL: 'http://flagsmith:8000/api/v1/feature-health/HEALTHTOKEN-abcdef123456' }, dir);
    await h.service.start();
    const api = await listen(h);

    // Flagsmith first answers with a message that repeats the keys, then goes away, then is fine.
    fake.leakKey = true;
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    const refused = h.service.state();
    expect(refused.flagsmith.switchOff.detail).toContain('[redacted]');
    fake.leakKey = false;
    fake.down = true;
    await h.clock.advanceBy(10_000);
    fake.down = false;
    await h.clock.advanceBy(30_000);
    expect(h.service.state().state.phase).toBe('watching');
    await play(h, buildRun('feature-bug'), START + 20_000);

    const responses = [
      await (await fetch(`${api.url}/api/state`)).text(),
      await (await fetch(`${api.url}/api/records`)).text(),
      await (await fetch(`${api.url}/api/arm`, { method: 'POST', body: '{}' })).text(),
      await (await fetch(`${api.url}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).text(),
    ];
    await api.close();
    await h.service.stop();

    const haystacks = [...h.logs, ...responses, ...filesUnder(dir).map((f) => f.text)];
    expect(h.logs.length).toBeGreaterThan(3);
    expect(filesUnder(dir).map((f) => f.path.replace(dir, '')).sort()).toEqual(expect.arrayContaining(['/data/state.json', '/runs/secret.jsonl']));
    for (const secret of SECRETS) {
      for (const text of haystacks) expect(text).not.toContain(secret);
    }
    expect(h.logs.join('\n')).toContain('[redacted]');
  });

  it('are blanked by the redactor wherever they appear, and short words are left alone', () => {
    const redact = makeRedactor(['abcdef123', 'ab']);
    expect(redact('key abcdef123 and abcdef123 again, ab stays')).toBe('key [redacted] and [redacted] again, ab stays');
    const lines: string[] = [];
    const log = createLogger(redact, (line) => lines.push(line));
    log.info('using abcdef123');
    log.warn('abcdef123 failed');
    expect(lines).toEqual(['using [redacted]', 'warning: [redacted] failed']);
  });

  it('are used in the right headers and nowhere in the address of a logged failure', async () => {
    h = harness(fake, START);
    await h.service.start();
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    const used = fake.headers.map((header) => [header.authorization, header['x-environment-key']]);
    expect(used.some(([auth]) => auth === `Api-Key ${ADMIN_KEY}`)).toBe(true);
    expect(used.some(([, key]) => key === ENV_KEY)).toBe(true);
    expect(readFileSync(join(h.dir, 'data', 'state.json'), 'utf8').length).toBeGreaterThan(0);
  });
});
