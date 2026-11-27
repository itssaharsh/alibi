// Run with: node --test load/extra-rules.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extraRules, oneSidedTwoProportionP } from './extra-rules.mjs';

test('the p-value matches two hand-computed cases', () => {
  // 30 of 100 against 15 of 100: pooled 0.225, standard error sqrt(0.225 * 0.775 * 0.02) = 0.059055, z = 2.5400, upper tail 0.00554
  assert.ok(Math.abs(oneSidedTwoProportionP(30, 100, 15, 100) - 0.005543) < 2e-5);
  // 20 of 50 against 5 of 50: pooled 0.25, standard error sqrt(0.25 * 0.75 * 0.04) = 0.086603, z = 3.4641, upper tail 0.000266
  assert.ok(Math.abs(oneSidedTwoProportionP(20, 50, 5, 50) - 0.000266) < 2e-6);
});

test('equal rates give about one half, and a lower flag-on rate gives more than one half', () => {
  assert.ok(Math.abs(oneSidedTwoProportionP(10, 100, 10, 100) - 0.5) < 1e-6);
  assert.ok(oneSidedTwoProportionP(5, 100, 15, 100) > 0.5);
  assert.equal(oneSidedTwoProportionP(0, 50, 0, 50), 1);
});

const verdict = (atMs, flagOn, failed) => ({ type: 'verdict', atMs, verdict: { evaluation: { flag: 'f', variation: flagOn ? 'v2' : 'stable', identity: 'u' }, flagOn, failed, endMs: atMs - 2000 } });

test('excess failures act when flag-on failures exceed stable failures by more than 15, counted from the start', () => {
  const events = [];
  for (let i = 0; i < 16; i++) events.push(verdict(1000 + i, true, true));
  events.push(verdict(2000, false, true));
  events.push(verdict(3000, true, true));
  // 16 against 0 is already more than 15 at the sixteenth
  assert.equal(extraRules(events).excessAtMs, 1015);
  // with one stable failure first, the sixteenth gives 15 and the seventeenth acts
  const skewed = [verdict(500, false, true), ...events.slice(0, 16), verdict(2500, true, true)];
  assert.equal(extraRules(skewed).excessAtMs, 2500);
});

test('the cumulative test needs 20 requests in each version and p below 0.001', () => {
  const events = [];
  for (let i = 0; i < 19; i++) events.push(verdict(i, false, false));
  for (let i = 0; i < 40; i++) events.push(verdict(100 + i, true, true));
  assert.equal(extraRules(events).cumulativeAtMs, null);
  events.push(verdict(300, false, false));
  const at = extraRules(events).cumulativeAtMs;
  assert.ok(at !== null && at >= 300);
});

test('untilMs stops the rules where Alibi switched off', () => {
  const events = [];
  for (let i = 0; i < 20; i++) events.push(verdict(1000 + i, true, true));
  assert.equal(extraRules(events, { untilMs: 1005 }).excessAtMs, null);
  assert.equal(extraRules(events).excessAtMs, 1015);
});
