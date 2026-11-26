import type {
  FlagsmithExperimentSummary,
  GuardEvent,
  GuardState,
  InvestigationRecord,
  RunHeader,
  RunLine,
  TraceVerdict,
} from './types.js';
import { TraceAssembler } from './assemble.js';
import { describeEvent, type TimelineEntry } from './format.js';
import { Guard } from './guard.js';
import { judgeTrace } from './judge.js';
import { buildRecord } from './record.js';

export interface ReplayOptions {
  /** Quiet time before a trace counts as complete. Default 2000. */
  settleMs?: number;
  /** Age at which an unfinished trace is dropped. Default 30000. */
  expireMs?: number;
  /** The clock ticks at least this often in run time. Default 1000. */
  tickMs?: number;
}

export interface ReplayResult {
  header: RunHeader;
  events: GuardEvent[];
  state: GuardState;
  verdicts: TraceVerdict[];
  /** Present once the watch has ended and the record is open. */
  record?: InvestigationRecord;
  timeline: TimelineEntry[];
}

export interface Replayer {
  readonly header: RunHeader;
  /** Time of the last recorded line. */
  readonly endsAtMs: number;
  /** Plays the run forward to `untilMs` on the run's own clock and returns the events that produced. */
  step(untilMs: number): GuardEvent[];
  result(): ReplayResult;
}

export class RunFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunFileError';
  }
}

const LINE_KINDS = new Set(['spans', 'flagsmith', 'world']);

/** Reads the text of a run file: one JSON value per line, the header first. */
export function parseRun(content: string): RunLine[] {
  const lines: RunLine[] = [];
  content.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new RunFileError(`line ${index + 1} is not valid JSON`);
    }
    const kind = (value as { kind?: unknown } | null)?.kind;
    const known = lines.length === 0 ? kind === 'alibi-run' : typeof kind === 'string' && LINE_KINDS.has(kind);
    if (!known) {
      throw new RunFileError(lines.length === 0 ? 'the first line is not an alibi-run header' : `line ${index + 1} has an unknown kind`);
    }
    lines.push(value as RunLine);
  });
  if (lines.length === 0) throw new RunFileError('the run file is empty');
  return lines;
}

export function serialiseRun(lines: readonly RunLine[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function isSummary(data: unknown): data is FlagsmithExperimentSummary {
  const d = data as Partial<FlagsmithExperimentSummary> | null;
  return typeof d === 'object' && d !== null && typeof d.experimentId === 'number' && typeof d.readAtMs === 'number' && Array.isArray(d.variations);
}

export function createReplayer(lines: readonly RunLine[], options: ReplayOptions = {}): Replayer {
  const [first, ...rest] = lines;
  if (!first || first.kind !== 'alibi-run') throw new RunFileError('the first line is not an alibi-run header');
  const header = first;
  const body = rest
    .filter((line): line is Exclude<RunLine, RunHeader> => line.kind !== 'alibi-run')
    .map((line, index) => ({ line, index }))
    .sort((a, b) => a.line.atMs - b.line.atMs || a.index - b.index)
    .map((entry) => entry.line);

  const tickMs = options.tickMs ?? 1000;
  const guard = new Guard(header.config);
  const assembler = new TraceAssembler({ settleMs: options.settleMs ?? 2000, expireMs: options.expireMs ?? 30000 });
  const events: GuardEvent[] = [];
  const verdicts: TraceVerdict[] = [];
  const timeline: TimelineEntry[] = [];
  const answers: { ok: boolean; detail: string }[] = [];
  const hasRecordedAnswer = body.some((line) => line.kind === 'flagsmith' && line.what === 'switch-off');
  let reportedMissingAnswer = false;
  let results: FlagsmithExperimentSummary | undefined;
  let record: InvestigationRecord | undefined;
  let cursor = 0;
  let nextTick = header.startedAtMs + tickMs;

  const emit = (fresh: GuardEvent[], out: GuardEvent[]): void => {
    for (const event of fresh) {
      events.push(event);
      out.push(event);
      const entry = describeEvent(event, header.config);
      if (entry) timeline.push(entry);
      if (event.type === 'labelled') {
        const notable = timeline.filter((e) => !e.failure);
        record = buildRecord(guard.state, verdicts, notable, results);
      }
    }
  };

  const settleSwitchOff = (nowMs: number, out: GuardEvent[]): void => {
    if (!guard.switchOffRequested) return;
    const answer = answers.shift();
    if (answer) {
      emit(guard.confirmSwitchOff(nowMs, answer.ok, answer.detail), out);
    } else if (!hasRecordedAnswer && !reportedMissingAnswer) {
      reportedMissingAnswer = true;
      emit(guard.confirmSwitchOff(nowMs, false, 'no recorded answer'), out);
    }
  };

  const drain = (nowMs: number, out: GuardEvent[]): void => {
    for (const trace of assembler.poll(nowMs).ready) {
      const verdict = judgeTrace(trace.spans, header.config);
      if (!verdict) continue;
      verdicts.push(verdict);
      emit(guard.ingest(verdict, nowMs), out);
    }
    emit(guard.tick(nowMs), out);
    settleSwitchOff(nowMs, out);
  };

  const apply = (line: Exclude<RunLine, RunHeader>, out: GuardEvent[]): void => {
    if (line.kind === 'spans') {
      assembler.add(line.spans, line.atMs);
    } else if (line.kind === 'world') {
      timeline.push({ atMs: line.atMs, text: line.text });
    } else if (line.what === 'switch-off') {
      answers.push({ ok: line.ok, detail: line.detail });
    } else if (line.what === 'results') {
      if (line.ok && isSummary(line.data)) results = line.data;
    } else if (line.what === 'evaluation-check') {
      timeline.push({ atMs: line.atMs, text: `Flagsmith check ${line.ok ? 'passed' : 'failed'}: ${line.detail}` });
    }
    drain(line.atMs, out);
  };

  return {
    header,
    endsAtMs: body.length > 0 ? (body[body.length - 1] as { atMs: number }).atMs : header.startedAtMs,
    step(untilMs) {
      const out: GuardEvent[] = [];
      for (;;) {
        const line = body[cursor];
        if (!line && assembler.pending === 0) break;
        if (Math.min(line ? line.atMs : Infinity, nextTick) > untilMs) break;
        if (line && line.atMs <= nextTick) {
          cursor += 1;
          apply(line, out);
        } else {
          drain(nextTick, out);
          nextTick += tickMs;
        }
      }
      return out;
    },
    result() {
      return {
        header,
        events: [...events],
        state: guard.state,
        verdicts: [...verdicts],
        ...(record ? { record } : {}),
        timeline: [...timeline],
      };
    },
  };
}

/** Plays a whole run file. The same file always gives the same result. */
export function replayRun(lines: readonly RunLine[], options?: ReplayOptions): ReplayResult {
  const replayer = createReplayer(lines, options);
  replayer.step(Infinity);
  return replayer.result();
}
