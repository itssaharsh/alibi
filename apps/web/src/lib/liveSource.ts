import type { FlatSpan, GuardEvent, GuardState, InvestigationRecord, Rates, TraceVerdict } from '@alibi/core';
import { momentOf, tagOf, type Board, type Moment, type Tag, type TimelineLine } from './viewModel';

/**
 * The live guard, behind one small adapter. The payloads are those of packages/guard (http.ts, service.ts):
 *   GET /api/state          -> { state: GuardState, flagsmith: { switchOff, results? }, recent?: TraceVerdict[],
 *                                timeline: { atMs, text, failure? }[], records: { id, label, openedAtMs }[],
 *                                run: { name, title, planted, startedAtMs, source }, lastSpanAtMs? }
 *   GET /api/events         -> server-sent, one NAMED event per kind (`event: verdict` and so on), each `data` JSON
 *                              with a `type`: the engine's GuardEvents, `rates` once a second, `world`, and a `state`
 *                              snapshot (the /api/state shape without `recent`) every 2 s
 *   GET /api/records/:id    -> InvestigationRecord;   GET /api/records -> the list
 *   GET /api/traces/:id     -> FlatSpan[] (the last 500 failing traces only)
 * Only GET requests are ever sent.
 */
export interface Live {
  stop(): void;
  trace(id: string): Promise<FlatSpan[]>;
}

interface Payload {
  state: GuardState;
  flagsmith?: { switchOff?: { requested: boolean; confirmed: boolean; detail: string } };
  recent?: TraceVerdict[];
  timeline?: { atMs: number; text: string; failure?: boolean }[];
  records?: { id: string; label: string; openedAtMs: number }[];
  run: { name: string; title: string; planted: string; startedAtMs: number; source: string };
  lastSpanAtMs?: number;
}

type StreamMessage =
  | GuardEvent
  | { type: 'state' } & Payload
  | { type: 'rates'; atMs: number; flagOn: Rates; stable: Rates; unflagged: Rates }
  | { type: 'world'; atMs: number; text: string };

const EVENT_NAMES = ['state', 'verdict', 'plain-rule-tripped', 'threshold-crossed', 'switched-off', 'watch-started', 'recovered', 'labelled', 'rates', 'world'];
const join = (url: string, path: string): string => `${url.replace(/\/$/, '')}${path}`;
const EMIT_EVERY_MS = 250;

export function connectLive(url: string, onBoard: (board: Board) => void, onDown: () => void): Live {
  let payload: Payload | undefined;
  let state: GuardState | undefined;
  let base = 0;
  let tags: Tag[] = [];
  let moments: Moment[] = [];
  let timeline: TimelineLine[] = [];
  let record: InvestigationRecord | undefined;
  let liveRate: Board['liveRate'];
  // The guard's clock, kept running between messages so the countdown moves smoothly.
  let serverAt = 0;
  let receivedAt = performance.now();
  let stopped = false;
  let source: EventSource | undefined;
  let timer = 0;
  let loading = false;

  const serverNow = (): number => serverAt + (performance.now() - receivedAt);
  const noteServerTime = (atMs: number): void => {
    if (atMs >= serverNow()) {
      serverAt = atMs;
      receivedAt = performance.now();
    }
  };
  const rel = (atMs: number): number => atMs - base;

  const emit = (): void => {
    if (!state || !payload || stopped) return;
    const run = payload.run;
    const now = Math.max(0, rel(serverNow()));
    onBoard({
      meta: { name: 'live', title: run.title, planted: run.planted, source: `live guard at ${new URL(url).host}`, startedAtMs: base },
      nowMs: now,
      endMs: now,
      state,
      tags,
      moments,
      timeline,
      ...(record ? { record } : {}),
      ...(liveRate ? { liveRate } : {}),
    });
  };

  const fetchRecord = (id: string | undefined): void => {
    if (!id) return;
    void fetch(join(url, `/api/records/${encodeURIComponent(id)}`))
      .then((r) => (r.ok ? (r.json() as Promise<InvestigationRecord>) : undefined))
      .then((r) => {
        if (r && !stopped) {
          record = r;
          emit();
        }
      })
      .catch(() => undefined);
  };

  const momentsFromState = (s: GuardState, answer: string | undefined): Moment[] => {
    const out: Moment[] = [];
    if (s.plainRuleTrippedAtMs !== undefined) out.push({ key: 'plain-rule', atMs: rel(s.plainRuleTrippedAtMs), text: 'The plain rule trips' });
    if (s.switchedOffAtMs !== undefined) out.push({ key: 'switched-off', atMs: rel(s.switchedOffAtMs), confirmed: s.switchOffConfirmed, ...(answer ? { detail: answer } : {}), text: 'Switched off in Flagsmith' });
    if (s.recoveredAtMs !== undefined) out.push({ key: 'recovered', atMs: rel(s.recoveredAtMs), text: 'Back at the stable level' });
    return out;
  };

  const timelineOf = (p: Payload): TimelineLine[] =>
    (p.timeline ?? []).filter((e) => !e.failure).map((e) => ({ atMs: rel(e.atMs), text: e.text }));

  /** Reads the whole state again: at the start, and whenever the guard starts a new run. */
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch(join(url, '/api/state'));
      if (!response.ok) throw new Error('state');
      const p = (await response.json()) as Payload;
      if (!p.state?.config || !p.run) throw new Error('state');
      payload = p;
      state = p.state;
      base = p.run.startedAtMs;
      record = undefined;
      tags = (p.recent ?? [])
        .map((v) => tagOf(v, base))
        .filter((t): t is Tag => t !== undefined)
        .sort((a, b) => a.atMs - b.atMs);
      moments = momentsFromState(state, p.flagsmith?.switchOff?.detail);
      timeline = timelineOf(p);
      const last = p.lastSpanAtMs ?? state.lastSpanAtMs ?? base;
      serverAt = last;
      receivedAt = performance.now();
      if (state.label) fetchRecord([...(p.records ?? [])].sort((a, b) => b.openedAtMs - a.openedAtMs)[0]?.id);
      emit();
    } finally {
      loading = false;
    }
  };

  const handle = (msg: StreamMessage): void => {
    if (!state || !payload) return;
    if (msg.type === 'state') {
      if (msg.run.startedAtMs !== base || msg.state.counted < state.counted) {
        void load().catch(() => undefined);
        return;
      }
      payload = { ...payload, ...msg, recent: payload.recent };
      state = msg.state;
      timeline = timelineOf(msg);
      if (state.label && !record) fetchRecord([...(msg.records ?? [])].sort((a, b) => b.openedAtMs - a.openedAtMs)[0]?.id);
      return;
    }
    if (msg.type === 'rates') {
      noteServerTime(msg.atMs);
      liveRate = {
        requests: msg.flagOn.requests + msg.stable.requests + msg.unflagged.requests,
        failures: msg.flagOn.failures + msg.stable.failures + msg.unflagged.failures,
      };
      return;
    }
    if (msg.type === 'world') {
      noteServerTime(msg.atMs);
      timeline = [...timeline, { atMs: rel(msg.atMs), text: msg.text }];
      return;
    }
    noteServerTime(msg.atMs);
    if (msg.type === 'verdict') {
      const tag = tagOf(msg.verdict, base);
      if (tag) {
        tags = [...tags, tag];
        // The same counting the guard does, so the lanes move now and the next snapshot confirms them.
        if (state.phase === 'armed') {
          const n = { ...state.notCounted };
          if (!tag.counted && tag.cls !== 'flagged-path') n[tag.cls === 'mixed' ? 'mixed' : tag.cls] += 1;
          const flagOn = { ...state.totals.flagOn, failures: state.totals.flagOn.failures + 1 };
          state = { ...state, counted: msg.counted, notCounted: n, totals: { ...state.totals, flagOn } };
        }
      }
      return;
    }
    const moment = momentOf(msg, base);
    if (moment) moments = [...moments, moment];
    if (msg.type === 'labelled') fetchRecord(msg.recordId);
  };

  void load()
    .then(() => {
      if (stopped) return;
      source = new EventSource(join(url, '/api/events'));
      for (const name of EVENT_NAMES) {
        source.addEventListener(name, (message) => {
          try {
            handle(JSON.parse((message as MessageEvent<string>).data) as StreamMessage);
          } catch {
            /* a message that is not JSON is skipped */
          }
        });
      }
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) onDown();
      };
      timer = window.setInterval(emit, EMIT_EVERY_MS);
    })
    .catch(() => onDown());

  return {
    stop() {
      stopped = true;
      source?.close();
      window.clearInterval(timer);
    },
    async trace(id) {
      const response = await fetch(join(url, `/api/traces/${encodeURIComponent(id)}`));
      if (!response.ok) return [];
      const json = (await response.json()) as FlatSpan[] | { spans: FlatSpan[] };
      return (Array.isArray(json) ? json : json.spans).map((s) => ({ ...s, events: [] }));
    },
  };
}
