import type { Board } from '../lib/viewModel';
import type { Controller } from '../lib/useBoard';
import { relMs } from '../lib/format';

const SPEEDS = [1, 8, 30];

export function Controls({ board, ctl }: { board: Board; ctl: Controller }) {
  const playing = ctl.mode === 'playing';
  const loading = ctl.mode === 'loading';
  const end = Math.max(1, board.endMs);
  return (
    <div className="controls" role="group" aria-label="Replay controls">
      <button type="button" className="ctl-play" aria-disabled={loading} onClick={() => (playing ? ctl.pause() : ctl.play())}>
        {playing ? 'Pause replay' : board.nowMs >= board.endMs - 1 ? 'Replay again' : 'Play'}
      </button>
      <span className="time" aria-hidden="true">
        {relMs(board.nowMs)} / {relMs(board.endMs)}
      </span>
      <div className="rail">
        <input
          type="range"
          min={0}
          max={end}
          step={500}
          value={Math.min(board.nowMs, end)}
          aria-label="Position in the run"
          aria-valuetext={`${relMs(board.nowMs)} of ${relMs(board.endMs)}`}
          onChange={(e) => ctl.seek(Number(e.target.value))}
        />
        {ctl.moments.map((m) => (
          <button
            key={`${m.key}${m.atMs}`}
            type="button"
            className={`tick ${m.key}${board.nowMs >= m.atMs ? ' reached' : ''}`}
            style={{ left: `${(m.atMs / end) * 100}%` }}
            title={`${m.text}, ${relMs(m.atMs)}`}
            aria-label={`Jump to: ${m.text}, ${relMs(m.atMs)}`}
            onClick={() => ctl.jump(m)}
          />
        ))}
      </div>
      <div className="seg" role="radiogroup" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={ctl.speed === s} className={ctl.speed === s ? 'on' : ''} onClick={() => ctl.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <div className="chips">
        {ctl.moments.map((m) => (
          <button key={`c${m.key}${m.atMs}`} type="button" className="chip-btn" onClick={() => ctl.jump(m)}>
            {m.text} <span className="muted">{relMs(m.atMs)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
