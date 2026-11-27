export const FORCED_STATES = [
  'armed', 'playing', 'paused', 'outage', 'coupon', 'host', 'switching', 'unconfirmed', 'watching',
  'labelled-feature', 'labelled-not-feature', 'loading', 'live-down', 'no-flagsmith-numbers', 'reduced',
] as const;
export type ForcedState = (typeof FORCED_STATES)[number];

export interface Params {
  run: string | null;
  t: number | null;
  state: ForcedState | null;
  record: boolean;
  autoplay: boolean;
  live: string | null;
  speed: number | null;
}

export function readParams(search: string): Params {
  const q = new URLSearchParams(search);
  const state = q.get('state');
  const t = q.get('t');
  return {
    run: q.get('run'),
    t: t !== null && Number.isFinite(Number(t)) ? Number(t) * 1000 : null,
    state: (FORCED_STATES as readonly string[]).includes(state ?? '') ? (state as ForcedState) : null,
    record: q.get('record') === '1',
    autoplay: q.get('autoplay') === '1',
    live: q.get('live'),
    speed: Number(q.get('speed')) > 0 ? Number(q.get('speed')) : null,
  };
}
