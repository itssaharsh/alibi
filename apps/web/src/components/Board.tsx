import { useEffect, useRef } from 'react';
import type { Board as BoardData, Tag } from '../lib/viewModel';
import type { Controller } from '../lib/useBoard';
import { relMs } from '../lib/format';
import { Waterfall } from './Waterfall';
import { Controls } from './Controls';
import type { Selected } from '../App';
import { plainRuleLine, alibiLine } from '../lib/format';

const PILE_CAP = 66;

function Glyph({ tag, n, onPick, selected, over }: { tag: Tag; n: number; onPick: (t: Tag) => void; selected: boolean; over?: boolean }) {
  return (
    <button
      type="button"
      className={`tag ${tag.counted ? 'hot' : 'dep'}${selected ? ' sel' : ''}${over ? ' over' : ''}`}
      aria-label={`Failing request ${n}, ${tag.counted ? 'counts' : 'does not count'}, trace ${tag.id.slice(0, 8)}`}
      onClick={() => onPick(tag)}
    >
      <span>{n}</span>
    </button>
  );
}

interface Props {
  board: BoardData;
  ctl: Controller;
  selected: Selected;
  onPick: (tag: Tag) => void;
  calm: boolean;
  record: boolean;
  skeleton: boolean;
}

export function Board({ board, ctl, selected, onPick, calm, record, skeleton }: Props) {
  const { state } = board;
  const counted = board.tags.filter((t) => t.counted);
  const rest = board.tags.filter((t) => !t.counted);
  const restCount = state.notCounted.dependency + state.notCounted.server + state.notCounted.mixed;
  const threshold = state.config.threshold;
  const slots = Array.from({ length: threshold + 1 }, (_, i) => i + 1);
  const finished = board.nowMs >= board.endMs - 1 && ctl.mode !== 'playing';
  const off = state.switchOffConfirmed;
  const warmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = warmRef.current;
    if (!el) return;
    let timer = 0;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) timer = window.setTimeout(ctl.warm, 800);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [ctl.warm]);

  const flagLabel = off
    ? 'is off in Flagsmith'
    : state.phase === 'switching-off'
      ? ctl.board?.moments.some((m) => m.key === 'switched-off' && m.confirmed === false)
        ? 'switch-off not confirmed, retrying in Flagsmith'
        : 'is being switched off in Flagsmith'
      : 'is on in Flagsmith';
  const runState = ctl.mode === 'playing' ? 'Playing' : ctl.mode === 'loading' ? 'Loading the run' : finished ? 'Finished' : 'Paused';

  return (
    <div className={`board${calm ? ' calm' : ''}`} ref={warmRef}>
      <div className="bar">
        <div className="flag">
          <span className={`tog${off ? ' off' : state.phase === 'switching-off' ? ' mid' : ''}`} aria-hidden="true" />
          <span>
            <b>{state.config.flag}</b> {flagLabel}
          </span>
        </div>
        <span className="muted small" role="status">
          {board.meta.title}, {runState.toLowerCase()}
          {board.meta.name === 'live' ? '' : ` at ${relMs(board.nowMs)}`}
        </span>
      </div>
      <div className="lanes">
        <div className="lane">
          <h3>On the flagged code</h3>
          <p className="muted small">Counts toward the switch-off</p>
          <div className="count" aria-label={`${state.counted} counted of ${threshold}`}>
            {skeleton ? '·' : state.counted}
            <small> / {threshold}</small>
          </div>
          <div className="slots">
            {slots.map((n) => {
              const tag = counted[n - 1];
              const over = n === threshold + 1;
              return tag ? (
                <Glyph key={tag.id} tag={tag} n={n} onPick={onPick} selected={selected.id === tag.id} over={over} />
              ) : (
                <div key={`s${n}`} className={`slot${over ? ' over' : ''}`} aria-hidden="true">
                  {over ? <span title={`Above ${threshold} the flag goes off`}>{n}</span> : n}
                </div>
              );
            })}
            {counted.length > threshold + 1 ? <span className="more">+{counted.length - threshold - 1} more</span> : null}
          </div>
        </div>
        <div className="lane right">
          <h3>In a dependency or the server</h3>
          <p className="muted small">Does not count</p>
          <div className="count dep">{skeleton ? '·' : restCount}</div>
          <div className="pile">
            {rest.slice(0, PILE_CAP).map((t, i) => (
              <Glyph key={t.id} tag={t} n={i + 1} onPick={onPick} selected={selected.id === t.id} />
            ))}
            {rest.length > PILE_CAP ? <span className="more">+{rest.length - PILE_CAP} more</span> : null}
            {rest.length === 0 && !skeleton ? <span className="muted small">Nothing has failed outside the flagged code.</span> : null}
          </div>
        </div>
      </div>
      <div className="mini">
        {selected.tag ? (
          <>
            <div className="mh">
              <b>Request {selected.tag.id.slice(0, 8)}</b> on {selected.tag.route}, {Math.round(selected.tag.durationMs)} ms
            </div>
            <Waterfall compact spans={selected.spans} loading={selected.loading} origins={selected.tag.origins} />
            <p className="mw">{selected.tag.reason}</p>
          </>
        ) : (
          <p className="muted small">Select a tag to see where that request failed.</p>
        )}
      </div>
      <div className="plain">
        <b>Plain error-rate rule</b>
        <span>
          {plainRuleLine(board, finished)} {alibiLine(board)}
        </span>
      </div>
      {record ? null : <Controls board={board} ctl={ctl} />}
    </div>
  );
}
