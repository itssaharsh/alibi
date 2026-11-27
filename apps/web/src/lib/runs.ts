import type { FlatSpan } from '@alibi/core';
import type { RunMeta, Snapshot } from './viewModel';

export interface RunEntry {
  name: string;
  title: string;
  planted: string;
  source: string;
  /** Bytes of the full run file. */
  size: number;
}

export interface RunIndex {
  runs: RunEntry[];
  default: string;
}

/** The small precomputed result of one run, written at build time from the engine's output on the run file. */
export interface RunSummary {
  meta: RunMeta;
  snapshot: Snapshot;
  /** One failing request, with its spans, so the first screen needs no large download. */
  featured?: { id: string; spans: FlatSpan[] };
}

const base = (path: string): string => new URL(path, document.baseURI).toString();

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(base(path));
  if (!response.ok) throw new Error(`${path} did not load (${response.status})`);
  return (await response.json()) as T;
}

export const loadIndex = (): Promise<RunIndex> => getJson<RunIndex>('runs/index.json');
export const loadSummary = (name: string): Promise<RunSummary> => getJson<RunSummary>(`runs/${name}.summary.json`);
export const runFileUrl = (name: string): string => base(`runs/${name}.jsonl`);

/** `coupon` finds `coupon-bug`, `host` finds `slow-host`, and so on. */
export function findRun(index: RunIndex, wanted: string | null): string {
  if (!wanted) return index.default;
  const exact = index.runs.find((r) => r.name === wanted);
  if (exact) return exact.name;
  const loose = index.runs.find((r) => r.name.includes(wanted) || wanted.includes(r.name));
  return loose ? loose.name : index.default;
}
