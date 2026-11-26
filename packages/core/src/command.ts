import { formatReport } from './format.js';
import { readRun } from './node.js';
import { replayRun } from './replay.js';
import type { RunLine } from './types.js';

export interface CliIo {
  read(path: string): RunLine[];
  out(text: string): void;
  err(text: string): void;
}

const USAGE = 'Usage: alibi replay <run file> [--json]\n';

const defaultIo: CliIo = {
  read: readRun,
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** Runs the command line and returns the exit code. */
export function runCli(argv: readonly string[], io: CliIo = defaultIo): number {
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  const files = args.filter((arg) => arg !== '--json');
  const [file] = files;
  if (command !== 'replay' || file === undefined || files.length !== 1) {
    io.err(USAGE);
    return 2;
  }
  let lines: RunLine[];
  try {
    lines = io.read(file);
  } catch (error) {
    io.err(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const result = replayRun(lines);
  io.out(json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
  return 0;
}
