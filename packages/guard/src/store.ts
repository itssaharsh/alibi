import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordToMarkdown, type InvestigationRecord, type TraceVerdict } from '@alibi/core';
import type { Tracker } from './clock.js';
import type { Logger } from './log.js';

export interface RecordSummary {
  id: string;
  label: string;
  openedAtMs: number;
}

export const RECORD_ID = /^[A-Za-z0-9_-]+$/;

/** Runs file writes one after another and reports a failed write once instead of throwing into the rule. */
class WriteQueue {
  private chain: Promise<void> = Promise.resolve();
  private reported = false;

  constructor(
    private readonly tracker: Tracker,
    private readonly log: Logger,
  ) {}

  run(what: string, work: () => Promise<void>): void {
    this.chain = this.chain.then(() =>
      this.tracker.track(Promise.resolve().then(work)).catch((error: unknown) => {
        if (this.reported) return;
        this.reported = true;
        this.log.warn(`${what} cannot be written: ${error instanceof Error ? error.message : 'unknown error'}`);
      }),
    );
  }

  done(): Promise<void> {
    return this.chain;
  }
}

/** The investigation records on disk: `<id>.json` and `<id>.md` in `<data>/records`. */
export class RecordStore {
  private readonly dir: string;
  private readonly writes: WriteQueue;
  private readonly index = new Map<string, RecordSummary>();

  constructor(dataDir: string, tracker: Tracker, log: Logger) {
    this.dir = join(dataDir, 'records');
    this.writes = new WriteQueue(tracker, log);
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as InvestigationRecord;
        this.index.set(record.id, { id: record.id, label: record.label, openedAtMs: record.openedAtMs });
      } catch {
        // a damaged file is left alone and not listed
      }
    }
  }

  list(): RecordSummary[] {
    return [...this.index.values()].sort((a, b) => a.openedAtMs - b.openedAtMs || a.id.localeCompare(b.id));
  }

  save(record: InvestigationRecord): void {
    this.index.set(record.id, { id: record.id, label: record.label, openedAtMs: record.openedAtMs });
    const json = `${JSON.stringify(record, null, 2)}\n`;
    const markdown = recordToMarkdown(record);
    this.writes.run(`record ${record.id}`, async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${record.id}.json`), json);
      await writeFile(join(this.dir, `${record.id}.md`), markdown);
    });
  }

  async readJson(id: string): Promise<string | undefined> {
    return RECORD_ID.test(id) ? readFile(join(this.dir, `${id}.json`), 'utf8').catch(() => undefined) : undefined;
  }

  async readMarkdown(id: string): Promise<string | undefined> {
    return RECORD_ID.test(id) ? readFile(join(this.dir, `${id}.md`), 'utf8').catch(() => undefined) : undefined;
  }

  async read(id: string): Promise<InvestigationRecord | undefined> {
    const text = await this.readJson(id);
    return text === undefined ? undefined : (JSON.parse(text) as InvestigationRecord);
  }
}

/** `state.json` (written whole, atomically) and `verdicts.jsonl` (added to), both in the data directory. */
export class StateFiles {
  private readonly writes: WriteQueue;

  constructor(
    private readonly dir: string,
    tracker: Tracker,
    log: Logger,
  ) {
    this.writes = new WriteQueue(tracker, log);
  }

  private get statePath(): string {
    return join(this.dir, 'state.json');
  }

  private get verdictsPath(): string {
    return join(this.dir, 'verdicts.jsonl');
  }

  async readState(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  async readVerdicts(limit: number): Promise<TraceVerdict[]> {
    let text: string;
    try {
      text = await readFile(this.verdictsPath, 'utf8');
    } catch {
      return [];
    }
    const out: TraceVerdict[] = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        out.push(JSON.parse(line) as TraceVerdict);
      } catch {
        // a half-written last line after a crash
      }
    }
    return out.slice(-limit);
  }

  writeState(state: unknown): void {
    const text = JSON.stringify(state);
    this.writes.run('state.json', async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${this.statePath}.tmp`, text);
      await rename(`${this.statePath}.tmp`, this.statePath);
    });
  }

  appendVerdicts(verdicts: readonly TraceVerdict[]): void {
    if (verdicts.length === 0) return;
    const text = verdicts.map((verdict) => `${JSON.stringify(verdict)}\n`).join('');
    this.writes.run('verdicts.jsonl', async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.verdictsPath, text);
    });
  }

  /** Replaces the whole verdict log, used when it has grown past what is kept. */
  replaceVerdicts(verdicts: readonly TraceVerdict[]): void {
    const text = verdicts.map((verdict) => `${JSON.stringify(verdict)}\n`).join('');
    this.writes.run('verdicts.jsonl', async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${this.verdictsPath}.tmp`, text);
      await rename(`${this.verdictsPath}.tmp`, this.verdictsPath);
    });
  }

  clearVerdicts(): void {
    this.writes.run('verdicts.jsonl', () => rm(this.verdictsPath, { force: true }));
  }

  done(): Promise<void> {
    return this.writes.done();
  }
}
