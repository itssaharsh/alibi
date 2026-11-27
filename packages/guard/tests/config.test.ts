import { describe, expect, it } from 'vitest';
import { ConfigError, apiRootOf, loadConfig } from '../src/config.js';

const base = { FLAGSMITH_EXPERIMENT_ID: '1', FLAGSMITH_API_URL: 'http://flagsmith:8000', FLAGSMITH_ENVIRONMENT_KEY: 'envkey123', FLAGSMITH_ADMIN_KEY: 'adminkey123' };
const nofile = (): string => {
  throw new Error('no file');
};
const load = (env: Record<string, string>, read: (path: string) => string = nofile) => loadConfig({ ALIBI_FLAGSMITH_FILE: '/shared/flagsmith.json', ...env }, read);
const reason = (env: Record<string, string>, read?: (path: string) => string): string => {
  try {
    load(env, read);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('configuration', () => {
  it('has sane defaults', () => {
    const c = load(base);
    expect(c).toMatchObject({ port: 4319, dataDir: './data', maxBodyBytes: 8 * 1024 * 1024 });
    expect(c.guard).toMatchObject({ flag: 'checkout_v2', stableVariation: 'stable', threshold: 15, watchMs: 300000 });
    expect(c.events).toEqual({ exposure: '$flag_exposure', completed: 'checkout_completed', failure: 'flag_path_failure', latency: 'checkout_latency_ms' });
    expect(c.flagsmith).toMatchObject({ apiRoot: 'http://flagsmith:8000', switchOff: 'rollout-zero', checkIdentities: 20, adminAuth: 'Api-Key adminkey123' });
    expect(c.secrets).toEqual(['envkey123', 'adminkey123']);
  });

  it('names the missing variable in one line', () => {
    expect(reason({ ...base, FLAGSMITH_API_URL: '' })).toBe('FLAGSMITH_API_URL is missing (set it, or provide "internalUrl" in /shared/flagsmith.json)');
    expect(reason({ FLAGSMITH_API_URL: 'http://f' })).toContain('FLAGSMITH_ENVIRONMENT_KEY is missing');
    expect(reason({ FLAGSMITH_API_URL: 'http://f', FLAGSMITH_ENVIRONMENT_KEY: 'k' })).toContain('FLAGSMITH_ADMIN_KEY is missing');
    expect(reason({ ...base, FLAGSMITH_EXPERIMENT_ID: '', ALIBI_SWITCH_OFF: 'rollout-zero' })).toContain('FLAGSMITH_EXPERIMENT_ID is missing');
    for (const message of [reason({ FLAGSMITH_API_URL: 'http://f' })]) expect(message).not.toContain('\n');
  });

  it('takes the admin token when there is no key', () => {
    const { FLAGSMITH_ADMIN_KEY: _key, ...rest } = base;
    expect(load({ ...rest, FLAGSMITH_ADMIN_TOKEN: 'tokentoken' }).flagsmith.adminAuth).toBe('Token tokentoken');
  });

  it('reads the bootstrap file, and lets environment variables override it', () => {
    const file = JSON.stringify({ internalUrl: 'http://flagsmith:8000', url: 'http://127.0.0.1:8000', environmentKey: 'fileenv123', masterKey: 'filemaster', serverKey: 'ser.fileserver', flag: 'file_flag', stableVariation: 'control', experimentId: 9, metrics: { checkout_completed: 11 } });
    const c = loadConfig({ ALIBI_FLAGSMITH_FILE: '/f.json' }, () => file);
    expect(c.flagsmith).toMatchObject({ apiRoot: 'http://flagsmith:8000', environmentKey: 'fileenv123', experimentId: 9, metrics: { checkout_completed: 11 } });
    expect(c.guard).toMatchObject({ flag: 'file_flag', stableVariation: 'control' });
    expect(c.secrets).toContain('ser.fileserver');
    const over = loadConfig({ ALIBI_FLAGSMITH_FILE: '/f.json', FLAGSMITH_ENVIRONMENT_KEY: 'envenv123', ALIBI_FLAG: 'env_flag' }, () => file);
    expect(over.flagsmith.environmentKey).toBe('envenv123');
    expect(over.guard.flag).toBe('env_flag');
  });

  it('rejects a bad file', () => {
    expect(reason(base, () => 'not json')).toBe('/shared/flagsmith.json is not a JSON object');
  });

  it('reads the rule file', () => {
    const rules = JSON.stringify({ flag: 'r_flag', stableVariation: 'old', threshold: 5, watchMs: 60000, tolerance: { windowMs: 30000, minRequests: 10, errorRatePoints: 1, p95Factor: 1.5 }, plainRule: { errorRate: 0.3 }, events: { completed: 'done' } });
    const c = load({ ...base, ALIBI_RULES: '/rules.json' }, (path) => {
      if (path === '/rules.json') return rules;
      throw new Error('no file');
    });
    expect(c.guard).toMatchObject({ flag: 'r_flag', stableVariation: 'old', threshold: 5, watchMs: 60000 });
    expect(c.guard.tolerance).toEqual({ windowMs: 30000, minRequests: 10, errorRatePoints: 1, p95Factor: 1.5 });
    expect(c.guard.plainRule).toEqual({ windowMs: 30000, minRequests: 20, errorRate: 0.3 });
    expect(c.events.completed).toBe('done');
    expect(c.events.failure).toBe('flag_path_failure');
  });

  it('rejects values it cannot use', () => {
    expect(reason({ ...base, ALIBI_THRESHOLD: 'many' })).toContain('ALIBI_THRESHOLD');
    expect(reason({ ...base, PORT: '0' })).toBe('PORT must be a whole number above 0');
    expect(reason({ ...base, ALIBI_SWITCH_OFF: 'explode' })).toBe('ALIBI_SWITCH_OFF must be one of: rollout-zero, disable-feature');
    expect(reason({ ...base, ALIBI_RULES: '/missing.json' })).toBe('/missing.json cannot be read');
  });

  it('turns an API address of any common shape into the host root', () => {
    for (const url of ['http://f:8000', 'http://f:8000/', 'http://f:8000/api', 'http://f:8000/api/', 'http://f:8000/api/v1/', 'http://f:8000/api/v1']) {
      expect(apiRootOf(url)).toBe('http://f:8000');
    }
  });

  it('keeps the run name, title, control token and recording paths', () => {
    const c = load({ ...base, ALIBI_RUN_NAME: 'bug', ALIBI_RUN_TITLE: 'The bug', ALIBI_RUN_PLANTED: 'A bug.', ALIBI_CONTROL_TOKEN: 'tokentoken', ALIBI_RECORD: '/r.jsonl', ALIBI_RECORD_DIR: '/runs' });
    expect(c).toMatchObject({ run: { name: 'bug', title: 'The bug', planted: 'A bug.' }, controlToken: 'tokentoken', recordPath: '/r.jsonl', recordDir: '/runs' });
    expect(c.secrets).toContain('tokentoken');
  });
});

describe('the experiment id', () => {
  it('is read from the bootstrap file again at each call unless it is set in the environment', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Tracker } = await import('../src/clock.js');
    const { FlagsmithApi } = await import('../src/flagsmith.js');
    const dir = mkdtempSync(join(tmpdir(), 'alibi-cfg-'));
    const file = join(dir, 'flagsmith.json');
    writeFileSync(file, JSON.stringify({ environmentKey: 'envkey123', masterKey: 'adminkey123', experimentId: 1, internalUrl: 'http://f:8000' }));
    const make = (extra: Record<string, string>) => {
      const config = loadConfig({ ALIBI_FLAGSMITH_FILE: file, ...extra });
      return new FlagsmithApi(config.flagsmith, { flag: 'checkout_v2', stable: 'stable' }, (t) => t, new Tracker());
    };
    const free = make({});
    const pinned = make({ FLAGSMITH_EXPERIMENT_ID: '1' });
    expect(await free.experimentId()).toBe(1);
    writeFileSync(file, JSON.stringify({ experimentId: 7 }));
    expect(await free.experimentId()).toBe(7);
    expect(await pinned.experimentId()).toBe(1);
    writeFileSync(file, 'broken');
    expect(await free.experimentId()).toBe(7);
  });
});
