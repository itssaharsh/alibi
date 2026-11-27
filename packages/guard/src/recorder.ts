import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunHeader, RunLine } from '@alibi/core';
import type { Tracker } from './clock.js';
import type { Logger } from './log.js';

/** Writes a run file: one JSON value per line, the header first. Lines are written in the order they are given. */
export class Recorder {
  private chain: Promise<void>;
  private failed = false;

  /**
   * `header` may still be a promise (the Flagsmith version is read first); lines given meanwhile wait behind it.
   * With `resume`, an existing file is added to and no second header is written.
   */
  constructor(
    readonly path: string,
    header: Promise<RunHeader>,
    private readonly tracker: Tracker,
    private readonly log: Logger,
    resume = false,
  ) {
    this.chain = this.queue(async () => {
      await mkdir(dirname(path), { recursive: true });
      if (resume && (await stat(path).then((info) => info.size > 0, () => false))) return;
      await writeFile(path, `${JSON.stringify(await header)}\n`);
    });
  }

  private queue(work: () => Promise<void>): Promise<void> {
    return this.tracker
      .track(Promise.resolve().then(work))
      .catch((error: unknown) => {
        if (!this.failed) this.log.warn(`the run file ${this.path} cannot be written: ${error instanceof Error ? error.message : 'unknown error'}`);
        this.failed = true;
      });
  }

  write(line: RunLine): void {
    const text = `${JSON.stringify(line)}\n`;
    this.chain = this.chain.then(() => this.queue(() => appendFile(this.path, text)));
  }

  async close(): Promise<void> {
    await this.chain;
  }
}
