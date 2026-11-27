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
  /** Scrolls a section into view on load: `trace`, `record`, `rule`, `plug`. For video capture. */
  focus: string | null;
  /** Opens this request: `?run=coupon-bug&trace=<id>`, or `?trace=<id>` on a live board. */
  trace: string | null;
}

/** Set at build time (`VITE_LIVE_SAME_ORIGIN=1`) by the compose stack, whose web server also forwards `/api/` to the guard. */
const SAME_ORIGIN_GUARD = import.meta.env.VITE_LIVE_SAME_ORIGIN === '1';

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
    // `?live=` with nothing after it turns the live board off; without the parameter the build-time default applies.
    live: q.get('live') ?? (SAME_ORIGIN_GUARD ? location.origin : null),
    speed: Number(q.get('speed')) > 0 ? Number(q.get('speed')) : null,
    focus: q.get('focus'),
    trace: q.get('trace'),
  };
}
