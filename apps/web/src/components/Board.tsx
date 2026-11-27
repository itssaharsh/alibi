import { useEffect, useRef } from 'react';
import type { Board as BoardData, Tag } from '../lib/viewModel';
import type { Controller } from '../lib/useBoard';
import { ms, relMs } from '../lib/format';
import { Waterfall } from './Waterfall';
import { Controls } from './Controls';
import type { Selected } from '../App';
import { SimplerRules } from './Sections';
import { Gloss } from './Gloss';

const PILE_CAP = 300;

function Glyph({ tag, n, onPick, selected, over, plain }: { tag: Tag; n: number; onPick: (t: Tag) => void; selected: boolean; over?: boolean; plain?: boolean }) {
  return (
    <button
      type="button"
      className={`tag ${tag.counted ? 'hot' : 'dep'}${selected ? ' sel' : ''}${over ? ' over' : ''}${plain ? ' small-tag' : ''}`}
      aria-label={`Failing request ${n}, ${tag.counted ? 'counts' : 'does not count'}, trace ${tag.id.slice(0, 8)}`}
      onClick={() => onPick(tag)}
    >
      {plain ? null : <span>{n}</span>}
    </button>
  );
}

/** Live traffic, one bar a second for the last minute: the board is alive even while nothing fails. */
function RateStrip({ history }: { history: NonNullable<BoardData['liveHistory']> }) {
  const peak = Math.max(4, ...history.map((h) => h.requests));
  const failed = history.reduce((n, h) => n + h.failures, 0);
  return (
    <div className="rate" role="img" aria-label={`Requests in each of the last ${history.length} seconds`}>
      <p className="muted small">
        Requests a second, last minute.{failed === 0 ? '' : ` ${failed} failed.`}
      </p>
      <div className="rate-bars">
        {history.map((h, i) => (
          <i key={i} className={h.failures ? 'bad' : ''} style={{ height: `${Math.max(6, (h.requests / peak) * 100)}%` }} />
        ))}
      </div>
    </div>
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
    ? 'is off for everyone in Flagsmith'
    : state.phase === 'switching-off'
      ? ctl.board?.moments.some((m) => m.key === 'switched-off' && m.confirmed === false)
        ? 'switch-off not confirmed, retrying in Flagsmith'
        : 'is being switched off in Flagsmith'
      : 'is on in Flagsmith';
  const runState = ctl.mode === 'playing' ? 'Playing' : ctl.mode === 'loading' ? (ctl.progress ? `Loading the run, ${(ctl.progress.loaded / 1e6).toFixed(1)}${ctl.progress.total ? ` of ${(ctl.progress.total / 1e6).toFixed(1)}` : ''} MB` : 'Loading the run') : finished ? 'Finished' : 'Paused';

  return (
    <div className={`board${calm ? ' calm' : ''}`} ref={warmRef}>
      <div className="bar">
        <div className="flag">
          <span className={`tog${off ? ' off' : state.phase === 'switching-off' ? ' mid' : ''}`} aria-hidden="true" />
          <span>
            <b>
              <Gloss term="checkout_v2">{state.config.flag}</Gloss>
            </b>{' '}
            {flagLabel}
          </span>
        </div>
        <span className="muted small" role="status">
          {board.meta.title}
          {board.meta.name === 'live' ? (/\blive\b/i.test(board.meta.title) ? '' : ', live') : `, ${runState.toLowerCase()}`}
          {board.meta.name === 'live'
            ? board.liveRate
              ? `, ${board.liveRate.requests} requests in the last second`
              : ''
            : ` at ${relMs(board.nowMs)}`}
        </span>
      </div>
      <div className="lanes">
        <div className="lane">
          <h3>
            On the <Gloss term="flagged code">flagged code</Gloss>
          </h3>
          <p className="muted small">the new checkout's own code</p>
          <div className="count" aria-label={`${state.counted} counted of ${threshold}`}>
            {skeleton ? '·' : state.counted}
            <small> / {threshold}</small>
          </div>
          <p className="muted small counts-note">counts; the flag goes off above {threshold}</p>
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
            {counted.length > threshold + 1 ? <span className="more" title="Failures on the flagged path after the switch-off was requested">+{counted.length - threshold - 1} more</span> : null}
          </div>
        </div>
        <div className="lane right">
          <h3>
            In a <Gloss term="dependency">dependency</Gloss> or the server
          </h3>
          <p className="muted small">database, other services, the server</p>
          <div className="count dep">{skeleton ? '·' : restCount}</div>
          <p className="muted small counts-note">does not count</p>
          <div className="pile">
            {rest.slice(0, PILE_CAP).map((t, i) => (
              <Glyph key={t.id} tag={t} n={i + 1} onPick={onPick} selected={selected.id === t.id} plain />
            ))}
            {rest.length > PILE_CAP ? <span className="more">+{rest.length - PILE_CAP} more</span> : null}
            {rest.length === 0 && !skeleton && !board.liveHistory ? <span className="muted small">No failures outside the flagged code.</span> : null}
          </div>
          {board.liveHistory && rest.length === 0 && !skeleton ? <RateStrip history={board.liveHistory} /> : null}
          {state.notices?.map((n) => (
            <p key={`${n.span}|${n.kind ?? ''}|${n.atMs}`} className="lane-notice">
              <b>Notice</b> {n.text}
            </p>
          ))}
        </div>
      </div>
      <div className="mini">
        {selected.tag ? (
          <>
            <div className="mh">
              <b>Request {selected.tag.id.slice(0, 8)}</b> on {selected.tag.route}, {ms(selected.tag.durationMs)}
            </div>
            <Waterfall compact spans={selected.spans} loading={selected.loading} origins={selected.tag.origins} />
            <p className="mw">{selected.tag.reason}</p>
          </>
        ) : (
          <p className="muted small">{board.tags.length === 0 ? 'No request has failed yet.' : 'Select a tag to see where that request failed.'}</p>
        )}
      </div>
      <SimplerRules board={board} finished={finished} />
      {record ? null : <Controls board={board} ctl={ctl} />}
    </div>
  );
}
