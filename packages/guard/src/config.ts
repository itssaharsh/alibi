import { readFileSync } from 'node:fs';
import { defaultConfig, type GuardConfig } from '@alibi/core';

/** The ways of switching a flag off that this service can carry out. */
export const SWITCH_OFF_STRATEGIES = ['rollout-zero'] as const;
export type SwitchOffStrategy = (typeof SWITCH_OFF_STRATEGIES)[number];

/** Names of the events sent to Flagsmith Experimentation. */
export interface EventNames {
  exposure: string;
  completed: string;
  failure: string;
  latency: string;
}

export interface FlagsmithSettings {
  /** Host root, for example `http://flagsmith:8000`; every call adds `/api/v1/...`. */
  apiRoot: string;
  environmentKey: string;
  /** The whole `Authorization` header value for the Admin API. */
  adminAuth: string;
  /** The experiment, from the environment or the bootstrap file as it was at start. The file is read again at each call. */
  experimentId: number;
  /** True when `FLAGSMITH_EXPERIMENT_ID` is set, so the file is never consulted. */
  experimentPinned: boolean;
  bootstrapFile: string;
  /** Metric id by metric name, as written by the bootstrap. */
  metrics: Record<string, number>;
  switchOff: SwitchOffStrategy;
  /**
   * Path of the Feature Health webhook (a secret: it holds the token), when Flagsmith has it. Alibi then marks the
   * flag unhealthy, with the reason, after a switch-off. The path is added to `apiRoot`.
   */
  featureHealthPath?: string;
  /** How many identities to evaluate when confirming a switch-off. */
  checkIdentities: number;
}

export interface ServiceConfig {
  port: number;
  dataDir: string;
  maxBodyBytes: number;
  guard: GuardConfig;
  events: EventNames;
  flagsmith: FlagsmithSettings;
  controlToken?: string;
  recordPath?: string;
  recordDir?: string;
  run: { name: string; title: string; planted: string };
  /** Every value that must never appear in a log line or a file. */
  secrets: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function readJsonFile(path: string, required: boolean, read: (path: string) => string): Json {
  let text: string;
  try {
    text = read(path);
  } catch {
    if (required) throw new ConfigError(`${path} cannot be read`);
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new ConfigError(`${path} is not a JSON object`);
  }
}

function positive(name: string, value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a number above 0`);
  return n;
}

function whole(name: string, value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a whole number above 0`);
  return n;
}

function text(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${name} must be a non-empty text`);
  return value;
}

/** Accepts `http://host:8000`, `http://host:8000/api` and `http://host:8000/api/v1/` alike. */
export function apiRootOf(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
}

function optionalId(env: Env, name: string, file: Json, fileKey: string): number | undefined {
  const raw = env[name] ?? file[fileKey];
  return raw === undefined || raw === '' ? undefined : whole(name, raw);
}

export function loadConfig(env: Env, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): ServiceConfig {
  const filePath = env.ALIBI_FLAGSMITH_FILE ?? '/shared/flagsmith.json';
  const file = readJsonFile(filePath, false, read);
  const rules = env.ALIBI_RULES ? readJsonFile(env.ALIBI_RULES, true, read) : {};

  const pick = (name: string, fileKey: string): string | undefined => {
    const value = env[name] ?? file[fileKey];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const need = (name: string, fileKey: string): string => {
    const value = pick(name, fileKey);
    if (value === undefined) throw new ConfigError(`${name} is missing (set it, or provide "${fileKey}" in ${filePath})`);
    return value;
  };

  const apiUrl = env.FLAGSMITH_API_URL ?? (typeof file.internalUrl === 'string' ? file.internalUrl : undefined) ?? (typeof file.url === 'string' ? file.url : undefined);
  if (!apiUrl) throw new ConfigError(`FLAGSMITH_API_URL is missing (set it, or provide "internalUrl" in ${filePath})`);
  const environmentKey = need('FLAGSMITH_ENVIRONMENT_KEY', 'environmentKey');
  const adminKey = pick('FLAGSMITH_ADMIN_KEY', 'masterKey');
  const adminToken = env.FLAGSMITH_ADMIN_TOKEN;
  if (!adminKey && !adminToken) {
    throw new ConfigError(`FLAGSMITH_ADMIN_KEY is missing (set it or FLAGSMITH_ADMIN_TOKEN, or provide "masterKey" in ${filePath})`);
  }

  const strategy = env.ALIBI_SWITCH_OFF ?? 'rollout-zero';
  if (!(SWITCH_OFF_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new ConfigError(`ALIBI_SWITCH_OFF must be one of: ${SWITCH_OFF_STRATEGIES.join(', ')}`);
  }

  const flag = env.ALIBI_FLAG ?? (rules.flag === undefined ? undefined : text('flag in the rule file', rules.flag)) ?? pick('ALIBI_FLAG', 'flag') ?? 'checkout_v2';
  const stable =
    env.ALIBI_STABLE_VARIATION ??
    (rules.stableVariation === undefined ? undefined : text('stableVariation in the rule file', rules.stableVariation)) ??
    pick('ALIBI_STABLE_VARIATION', 'stableVariation') ??
    'stable';
  const guard = defaultConfig(flag, stable);
  const threshold = env.ALIBI_THRESHOLD ?? rules.threshold;
  if (threshold !== undefined) guard.threshold = whole('ALIBI_THRESHOLD (or threshold in the rule file)', threshold);
  const watch = env.ALIBI_WATCH_MS ?? rules.watchMs;
  if (watch !== undefined) guard.watchMs = whole('ALIBI_WATCH_MS (or watchMs in the rule file)', watch);
  for (const [section, target] of [
    ['tolerance', guard.tolerance],
    ['plainRule', guard.plainRule],
  ] as const) {
    const given = rules[section];
    if (given === undefined) continue;
    if (!isRecord(given)) throw new ConfigError(`${section} in the rule file must be an object`);
    for (const key of Object.keys(target) as (keyof typeof target)[]) {
      if (given[key] !== undefined) (target as Record<string, number>)[key] = positive(`${section}.${key} in the rule file`, given[key]);
    }
  }

  const events: EventNames = { exposure: '$flag_exposure', completed: 'checkout_completed', failure: 'flag_path_failure', latency: 'checkout_latency_ms' };
  if (rules.events !== undefined) {
    if (!isRecord(rules.events)) throw new ConfigError('events in the rule file must be an object');
    for (const key of Object.keys(events) as (keyof EventNames)[]) {
      if (rules.events[key] !== undefined) events[key] = text(`events.${key} in the rule file`, rules.events[key]);
    }
  }

  const metrics: Record<string, number> = {};
  if (isRecord(file.metrics)) {
    for (const [name, id] of Object.entries(file.metrics)) if (typeof id === 'number') metrics[name] = id;
  }

  const experimentId = optionalId(env, 'FLAGSMITH_EXPERIMENT_ID', file, 'experimentId');
  if (experimentId === undefined) throw new ConfigError(`FLAGSMITH_EXPERIMENT_ID is missing (set it, or provide "experimentId" in ${filePath})`);
  const controlToken = env.ALIBI_CONTROL_TOKEN === '' ? undefined : env.ALIBI_CONTROL_TOKEN;
  const name = env.ALIBI_RUN_NAME ?? 'live';

  const flagsmith: FlagsmithSettings = {
    apiRoot: apiRootOf(apiUrl),
    environmentKey,
    adminAuth: adminKey ? `Api-Key ${adminKey}` : `Token ${adminToken ?? ''}`,
    experimentId,
    experimentPinned: env.FLAGSMITH_EXPERIMENT_ID !== undefined && env.FLAGSMITH_EXPERIMENT_ID !== '',
    bootstrapFile: filePath,
    metrics,
    switchOff: strategy as SwitchOffStrategy,
    checkIdentities: env.ALIBI_CHECK_IDENTITIES === undefined ? 20 : whole('ALIBI_CHECK_IDENTITIES', env.ALIBI_CHECK_IDENTITIES),
  };

  const secrets = [environmentKey, adminKey, adminToken, controlToken, pick('FLAGSMITH_SERVER_KEY', 'serverKey')].filter(
    (secret): secret is string => typeof secret === 'string' && secret !== '',
  );

  const config: ServiceConfig = {
    port: env.PORT === undefined ? 4319 : whole('PORT', env.PORT),
    dataDir: env.ALIBI_DATA ?? './data',
    maxBodyBytes: env.ALIBI_MAX_BODY_BYTES === undefined ? 8 * 1024 * 1024 : whole('ALIBI_MAX_BODY_BYTES', env.ALIBI_MAX_BODY_BYTES),
    guard,
    events,
    flagsmith,
    run: { name, title: env.ALIBI_RUN_TITLE ?? name, planted: env.ALIBI_RUN_PLANTED ?? 'Not stated.' },
    secrets,
  };
  const healthUrl = pick('FLAGSMITH_FEATURE_HEALTH_URL', 'featureHealthUrl');
  if (healthUrl !== undefined) {
    let path: string;
    try {
      path = new URL(healthUrl).pathname;
    } catch {
      throw new ConfigError('FLAGSMITH_FEATURE_HEALTH_URL is not a web address');
    }
    config.flagsmith.featureHealthPath = path;
    config.secrets.push(healthUrl, path, path.split('/').filter(Boolean).pop() ?? path);
  }
  if (controlToken) config.controlToken = controlToken;
  if (env.ALIBI_RECORD) config.recordPath = env.ALIBI_RECORD;
  if (env.ALIBI_RECORD_DIR) config.recordDir = env.ALIBI_RECORD_DIR;
  return config;
}
