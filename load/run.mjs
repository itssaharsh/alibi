#!/usr/bin/env node
// Drives steady shop traffic and the three scripted scenarios against the compose stack.
// Run it on the machine that runs the stack, from the repository root:
//
//   node load/run.mjs <outage|coupon-bug|degraded-host> [--rps 2] [--minutes N] [--out file]
//   (degraded-host also takes --cpus, the CPU limit it puts on the shop, default 0.05)
//   node load/run.mjs reset
//
// Environment: SHOP_URL (default http://127.0.0.1:8080), ALIBI_URL (default http://127.0.0.1:4319, the guard of the
// compose stack; set it to an empty value to run without a guard). At the start the run arms the guard with its name
// and a recording, every world line is also posted to $ALIBI_URL/api/world, and at the end of the run $ALIBI_URL/api/finish is called so Alibi reads
// Flagsmith's numbers and closes its recording). ALIBI_CONTROL_TOKEN, when set, is sent as a bearer token.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = join(ROOT, 'deploy', 'docker-compose.yml');
const FLAGSMITH_JSON = join(ROOT, 'deploy', 'data', 'shared', 'flagsmith.json');

const SHOP_URL = process.env.SHOP_URL ?? 'http://127.0.0.1:8080';
const ALIBI_URL = process.env.ALIBI_URL ?? 'http://127.0.0.1:4319';
const SEED = 20261127;
const IDENTITIES = 600;
const COUPON = 'SAVE10';
const COUPON_SHARE = 0.2;
const THROTTLED_CPUS = '0.05';
const FLAGGED_FAILURES_BEFORE_WATCH = 16;
const WATCH_MS = 6 * 60_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

// ---------------------------------------------------------------- docker

async function compose(...args) {
  const { stdout } = await run('docker', ['compose', '-f', COMPOSE_FILE, ...args], { maxBuffer: 10_000_000 });
  return stdout.trim();
}

async function shopContainer() {
  const id = await compose('ps', '-q', 'shop');
  if (!id) throw new Error('The shop container is not running. Start the stack first.');
  return id;
}

async function limitShopCpu(cpus) {
  await run('docker', ['update', '--cpus', String(cpus), await shopContainer()]);
}

// Docker keeps a limit once it is set: `--cpus 0` changes nothing. Allowing every core is the same as no limit.
async function unlimitShopCpu() {
  await limitShopCpu(availableParallelism());
}

async function waitUntilHealthy(service, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    const id = await compose('ps', '-q', service);
    if (id) {
      const { stdout } = await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]);
      if (stdout.trim() === 'healthy') return;
    }
    await sleep(1000);
  }
  throw new Error(`${service} did not become healthy in ${seconds} s`);
}

// ---------------------------------------------------------------- world lines

function alibiHeaders() {
  const token = process.env.ALIBI_CONTROL_TOKEN;
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** Tells Alibi the run is over: it reads Flagsmith's numbers if no record was opened, and closes its recording. */
async function finishAlibi() {
  if (!ALIBI_URL) return;
  try {
    const res = await fetch(`${ALIBI_URL}/api/finish`, { method: 'POST', headers: alibiHeaders(), body: '{}', signal: AbortSignal.timeout(7 * 60_000) });
    if (!res.ok) console.error(`Alibi did not finish the run: HTTP ${res.status}`);
  } catch (error) {
    console.error(`Alibi did not finish the run: ${error.message}`);
  }
}

/** Arms the guard for this run: a clean start, the run's name and title, and a recording named after it. */
async function armAlibi(record) {
  if (!ALIBI_URL) return;
  try {
    const res = await fetch(`${ALIBI_URL}/api/arm`, {
      method: 'POST',
      headers: alibiHeaders(),
      body: JSON.stringify({ ...record, force: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`Alibi did not arm for this run: HTTP ${res.status}`);
  } catch (error) {
    console.error(`Alibi is not reachable at ${ALIBI_URL}, so this run is not watched or recorded: ${error.message}`);
  }
}

/** World lines go to the guard's timeline and recording; with an output path they are also written to a file. */
function makeWorld(outPath) {
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, '');
  }
  return async function world(text) {
    const line = { kind: 'world', atMs: Date.now(), text };
    const json = JSON.stringify(line);
    if (outPath) appendFileSync(outPath, json + '\n');
    console.log(json);
    if (!ALIBI_URL) return;
    try {
      const res = await fetch(`${ALIBI_URL}/api/world`, {
        method: 'POST',
        headers: alibiHeaders(),
        body: json,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.error(`Alibi did not take the world line: HTTP ${res.status}`);
    } catch (error) {
      console.error(`Alibi did not take the world line: ${error.message}`);
    }
  };
}

// ---------------------------------------------------------------- traffic

/** A small seeded random generator, so the same seed gives the same carts. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTraffic({ rps }) {
  const random = seededRandom(SEED);
  const stats = { requests: 0, byStatus: new Map(), byVariation: new Map(), flaggedCouponFailures: 0, flaggedCouponFailureAtMs: null };
  const state = { couponsOn: false };
  const inFlight = new Set();
  let timer = null;

  function nextCart() {
    const userId = `u-${String(1 + Math.floor(random() * IDENTITIES)).padStart(4, '0')}`;
    const lines = 1 + Math.floor(random() * 3);
    const items = Array.from({ length: lines }, () => ({
      sku: `SKU-${String(1 + Math.floor(random() * 40)).padStart(4, '0')}`,
      qty: 1 + Math.floor(random() * 3),
    }));
    const wantsCoupon = random() < COUPON_SHARE;
    return { userId, items, coupon: state.couponsOn && wantsCoupon ? COUPON : null };
  }

  function count(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  async function send() {
    const cart = nextCart();
    stats.requests++;
    let status;
    let variation = 'none';
    try {
      const res = await fetch(`${SHOP_URL}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cart),
        signal: AbortSignal.timeout(10_000),
      });
      status = String(res.status);
      const body = await res.json().catch(() => ({}));
      variation = body.checkout ?? 'none';
    } catch (error) {
      status = error.name === 'TimeoutError' ? 'client-timeout' : 'no-answer';
    }
    count(stats.byStatus, status);
    count(stats.byVariation, variation);
    if (status === '500' && variation === 'v2' && cart.coupon) {
      stats.flaggedCouponFailures++;
      if (stats.flaggedCouponFailures === FLAGGED_FAILURES_BEFORE_WATCH) stats.flaggedCouponFailureAtMs = Date.now();
    }
  }

  return {
    stats,
    state,
    start() {
      const interval = 1000 / rps;
      const begun = performance.now();
      let n = 0;
      const tick = () => {
        const job = send().finally(() => inFlight.delete(job));
        inFlight.add(job);
        n++;
        timer = setTimeout(tick, Math.max(0, begun + n * interval - performance.now()));
      };
      tick();
    },
    async stop() {
      clearTimeout(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
}

function summary(name, stats, seconds) {
  const fmt = (map) => [...map].sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  return `${name}: ${stats.requests} requests in ${Math.round(seconds)} s. By status: ${fmt(stats.byStatus)}. By variation: ${fmt(stats.byVariation)}.`;
}

// ---------------------------------------------------------------- scenarios

/**
 * Each scenario gets the traffic controller, the world logger and its total length, and runs its script.
 * `cleanup` runs even when the script fails, so a crashed run cannot leave the stack broken.
 */
const scenarios = {
  outage: {
    record: { name: 'outage', title: 'The database outage', planted: "The shop's database was stopped for 90 seconds. Nothing was wrong with the new checkout." },
    minutes: 4,
    async script({ world, totalMs }) {
      await sleep(60_000);
      await world("The shop's database was stopped.");
      await compose('stop', 'shop-db');
      await sleep(90_000);
      await compose('start', 'shop-db');
      await world("The shop's database was started again.");
      await sleep(Math.max(0, totalMs - 150_000));
    },
    async cleanup() {
      await compose('start', 'shop-db');
    },
  },

  'coupon-bug': {
    record: { name: 'coupon-bug', title: 'The coupon bug', planted: "Carts with the SAVE10 coupon crash inside the new checkout's own code." },
    minutes: 9,
    async script({ world, traffic, totalMs }) {
      const started = Date.now();
      await sleep(90_000);
      traffic.state.couponsOn = true;
      await world('Carts with the SAVE10 coupon began (about 1 in 5).');
      let announced = false;
      let endAt = started + totalMs;
      while (Date.now() < endAt) {
        await sleep(1000);
        const at = traffic.stats.flaggedCouponFailureAtMs;
        if (at && !announced) {
          announced = true;
          endAt = Math.max(endAt, at + WATCH_MS);
        }
      }
    },
    async cleanup() {},
  },

  'degraded-host': {
    record: { name: 'slow-host', title: 'The slow host', planted: "The shop's CPU was throttled to a twentieth of a core. Nothing was changed in the new checkout." },
    minutes: 9,
    async script({ world, totalMs, args }) {
      const cpus = args.cpus ?? THROTTLED_CPUS;
      await sleep(90_000);
      await limitShopCpu(cpus);
      await world(`The shop host was slowed down: the shop's CPU was limited to ${Math.round(Number(cpus) * 100)}% of one core.`);
      await sleep(Math.max(0, totalMs - 90_000));
    },
    async cleanup() {
      await unlimitShopCpu();
    },
  },
};

async function runScenario(name, args) {
  const scenario = scenarios[name];
  const rps = Number(args.rps ?? 2);
  const minutes = Number(args.minutes ?? scenario.minutes);
  const totalMs = minutes * 60_000;
  const out = args.out ? resolve(args.out) : undefined;
  await armAlibi(scenario.record);
  console.log(`Watch it live at http://127.0.0.1:4173 (the board), Flagsmith at http://127.0.0.1:8000, traces at http://127.0.0.1:16686.`);
  const world = makeWorld(out);
  const traffic = makeTraffic({ rps });

  await world(`Run "${name}" started: ${rps} requests per second from ${IDENTITIES} shoppers.`);
  const startedAt = Date.now();
  traffic.start();
  const abort = () => {
    scenario.cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    await scenario.script({ world, traffic, totalMs, args });
  } finally {
    await traffic.stop();
    await scenario.cleanup();
    await world(`Run "${name}" ended.`);
    await finishAlibi();
  }
  console.log(summary(name, traffic.stats, (Date.now() - startedAt) / 1000));
  if (out) console.log(`World lines are in ${out}`);
}

// ---------------------------------------------------------------- reset

/**
 * Puts the stack back to its starting state so a run can be repeated:
 *  1. removes the CPU limit from the shop,
 *  2. starts the shop database if it is stopped,
 *  3. runs the bootstrap again, which creates a new experiment when the old one was completed,
 *  4. makes sure the experiment is running, serves the new checkout to 50% of shoppers (rollout 100%),
 *     and the flag's feature state is on.
 * Events already stored in Flagsmith's experiment results are not removed; the API has no call for that.
 */
async function reset() {
  await unlimitShopCpu();
  console.log('Shop CPU limit removed.');
  await compose('start', 'shop-db');
  await waitUntilHealthy('shop-db');
  console.log('Shop database is running.');
  await compose('run', '--rm', 'bootstrap');

  const f = JSON.parse(readFileSync(FLAGSMITH_JSON, 'utf8'));
  const api = async (method, path, body) => {
    const res = await fetch(`${f.url}/api/v1/${path}`, {
      method,
      headers: { authorization: `Api-Key ${f.masterKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  };
  const experiment = `environments/${f.environmentKey}/experiments/${f.experimentId}`;

  if ((await api('GET', `${experiment}/`)).status === 'paused') await api('POST', `${experiment}/start/`);
  await api('PATCH', `${experiment}/rollout/`, {
    enabled: true,
    rollout_percentage: 100,
    feature_state_value: { type: 'string', value: f.stableVariation },
    multivariate_feature_state_values: [{ multivariate_feature_option: f.variationOptionId, percentage_allocation: 50 }],
  });
  const states = await api('GET', `environments/${f.environmentKey}/featurestates/?feature=${f.featureId}`);
  const featureState = (states.results ?? states)[0];
  await api('PATCH', `environments/${f.environmentKey}/featurestates/${featureState.id}/`, { enabled: true });
  console.log(`Flag ${f.flag} is on and experiment ${f.experimentId} serves ${f.variation} to half of the shoppers.`);
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
try {
  if (command === 'reset') await reset();
  else if (scenarios[command]) await runScenario(command, args);
  else {
    console.error('Usage: node load/run.mjs <outage|coupon-bug|degraded-host|reset> [--rps 2] [--minutes N] [--out file] [--cpus 0.05]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
