import { describeEvent, type FlatSpan, type GuardConfig, type GuardEvent, type GuardState, type InvestigationRecord } from '@alibi/core';
import { momentOf, tagOf, type Board, type Moment, type Tag, type TimelineLine } from './viewModel';

/**
 * The live guard, behind one small adapter. It expects (packages/guard):
 *   GET  {url}/api/state            -> a GuardState, or { state: GuardState }
 *   SSE  {url}/api/events           -> each message's data is JSON with a `type`: any engine GuardEvent,
 *                                      { type: 'rates', ... } once a second (read for liveness only),
 *                                      { type: 'state', state: GuardState } every 2 s
 *   GET  {url}/api/records/:id      -> an InvestigationRecord
 *   GET  {url}/api/traces/:traceId  -> FlatSpan[], or { spans: FlatSpan[] }
 */
export interface Live {
  stop(): void;
  trace(id: string): Promise<FlatSpan[]>;
}

const join = (url: string, path: string): string => `${url.replace(/\/$/, '')}${path}`;

export function connectLive(url: string, onBoard: (board: Board) => void, onDown: () => void): Live {
  let state: GuardState | undefined;
  let baseMs: number | undefined;
  let nowMs = 0;
  let tags: Tag[] = [];
  let moments: Moment[] = [];
  let timeline: TimelineLine[] = [];
  let record: InvestigationRecord | undefined;
  let stopped = false;
  let source: EventSource | undefined;

  const emit = (): void => {
    if (!state || stopped) return;
    const meta = { name: 'live', title: `Live: ${state.config.flag}`, planted: '', source: `live guard at ${new URL(url).host}`, startedAtMs: baseMs ?? 0 };
    onBoard({ meta, nowMs, endMs: nowMs, state, tags, moments, timeline, ...(record ? { record } : {}) });
  };
  const rel = (atMs: number): number => {
    if (baseMs === undefined) baseMs = atMs;
    nowMs = Math.max(nowMs, atMs - baseMs);
    return atMs - baseMs;
  };
  const stateOf = (value: unknown): GuardState | undefined => {
    const v = value as { state?: GuardState; config?: GuardConfig } | null;
    if (v?.state?.config) return v.state;
    if (v?.config) return v as GuardState;
    return undefined;
  };

  const handle = (event: GuardEvent | { type: 'rates' } | { type: 'state'; state: GuardState }): void => {
    if (event.type === 'state') {
      state = event.state;
      if (state.lastSpanAtMs !== undefined) rel(state.lastSpanAtMs);
    } else if (event.type === 'rates') {
      /* liveness only */
    } else {
      rel(event.atMs);
      if (event.type === 'verdict') {
        const tag = tagOf(event.verdict, baseMs ?? 0);
        if (tag) tags = [...tags, tag];
        if (state) state = { ...state, counted: event.counted };
      } else {
        const moment = momentOf(event, baseMs ?? 0);
        if (moment) moments = [...moments, moment];
        if (state) {
          const entry = describeEvent(event, state.config);
          if (entry) timeline = [...timeline, { atMs: entry.atMs - (baseMs ?? 0), text: entry.text }];
        }
        if (event.type === 'labelled') {
          void fetch(join(url, `/api/records/${encodeURIComponent(event.recordId)}`))
            .then((r) => (r.ok ? (r.json() as Promise<InvestigationRecord>) : undefined))
            .then((r) => {
              if (r) {
                record = r;
                emit();
              }
            })
            .catch(() => undefined);
        }
      }
    }
    emit();
  };

  void fetch(join(url, '/api/state'))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('state'))))
    .then((json: unknown) => {
      state = stateOf(json);
      if (!state) throw new Error('state');
      if (state.lastSpanAtMs !== undefined) rel(state.lastSpanAtMs);
      emit();
      source = new EventSource(join(url, '/api/events'));
      source.onmessage = (message) => {
        try {
          handle(JSON.parse(message.data as string));
        } catch {
          /* a message that is not JSON is skipped */
        }
      };
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) onDown();
      };
    })
    .catch(() => onDown());

  return {
    stop() {
      stopped = true;
      source?.close();
    },
    async trace(id) {
      const response = await fetch(join(url, `/api/traces/${encodeURIComponent(id)}`));
      if (!response.ok) return [];
      const json = (await response.json()) as FlatSpan[] | { spans: FlatSpan[] };
      return Array.isArray(json) ? json : json.spans;
    },
  };
}
