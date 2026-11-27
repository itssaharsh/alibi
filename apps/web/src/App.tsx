import { useEffect, useMemo, useState } from 'react';
import type { FlatSpan } from '@alibi/core';
import { readParams } from './lib/params';
import { useBoard } from './lib/useBoard';
import type { Tag } from './lib/viewModel';
import { lowerFirst } from './lib/format';
import { REPO_URL } from './lib/copy';
import { Board } from './components/Board';
import { AuthorRule, Footer, FailingAndTrace, FlagsmithNumbers, PlugIn, Record, VerdictCard, WatchBand } from './components/Sections';

export interface Selected {
  id?: string;
  tag?: Tag;
  spans?: FlatSpan[];
  loading: boolean;
}

const isLiveRef = (source: string): boolean => source === 'live';

export function App() {
  const params = useMemo(() => readParams(location.search), []);
  const ctl = useBoard(params);
  const { board, index, mode } = ctl;
  const [selected, setSelected] = useState<Selected>({ loading: false });

  // The first failing request is open on arrival, from the small summary, with no large download.
  useEffect(() => {
    if (!board || selected.id || !ctl.featured) return;
    const tag = board.tags.find((t) => t.id === ctl.featured?.id);
    if (tag) setSelected({ id: tag.id, tag, spans: ctl.featured.spans, loading: false });
  }, [board, ctl.featured, selected.id]);

  // On a live board the first counted failure is open by default.
  useEffect(() => {
    if (!isLiveRef(ctl.source) || !board || selected.id || board.tags.length === 0) return;
    pick(board.tags.find((t) => t.counted) ?? board.tags[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl.source, board?.tags.length, selected.id]);

  useEffect(() => {
    if (!params.focus || !board) return;
    const id = window.setTimeout(() => document.getElementById(`focus-${params.focus}`)?.scrollIntoView({ block: 'start' }), 600);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(board), params.focus]);

  const pick = (tag: Tag): void => {
    setSelected({ id: tag.id, tag, loading: true });
    void ctl.trace(tag.id).then((spans) => setSelected((s) => (s.id === tag.id ? { id: tag.id, tag, spans, loading: false } : s)));
  };

  const skeleton = params.state === 'loading';
  const reduced = params.state === 'reduced';
  const entry = index?.runs.find((r) => r.name === board?.meta.name);
  const title = entry?.title ?? board?.meta.title ?? 'the database outage';
  const isLive = ctl.source === 'live';
  const playing = mode === 'playing';
  const caption =
    ctl.source === 'live'
      ? `Live from ${board?.meta.source.replace('live guard at ', '') ?? ''}`
      : ctl.source === 'live-down'
        ? `Live runs are paused. This is the ${board?.meta.title.toLowerCase() ?? ''} replay.`
        : board
          ? (
              <>
                Replay of a recorded run<span className="cap-src">: {board.meta.source}</span>
              </>
            )
          : '';

  return (
    <div className={`page${params.record ? ' rec' : ''}${reduced ? ' reduce' : ''}`}>
      <div className="wrap">
        <nav>
          <a className="logo" href="./" aria-label="Alibi">
            <i aria-hidden="true" />
            Alibi
          </a>
          <span className="muted small nav-cap">
            {caption}
            {REPO_URL && !params.record ? (
              <>
                {', '}
                <a href={REPO_URL}>GitHub</a>
              </>
            ) : null}
          </span>
        </nav>
        <main>
          <section className="hero">
            <div className="hero-l">
              <h1>
                Was it the <em>flag</em>, or was the database down?
              </h1>
              <p className="sub">Alibi switches a feature flag off only when the feature's own code is failing, and shows you why.</p>
              {board ? <VerdictCard board={board} ctl={ctl} skeleton={skeleton} /> : <div className="verdict sk" style={{ height: 120 }} aria-busy="true" />}
              {isLive ? null : (
              <button type="button" className="btn" aria-disabled={mode === 'loading'} onClick={() => (playing ? ctl.pause() : ctl.play())}>
                <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span> {playing ? 'Pause replay' : `Replay ${lowerFirst(title)}`}
              </button>
              )}
              {!params.record && !isLive && index ? (
                <div className="try" role="group" aria-label="Try these">
                  <span>Try these</span>
                  {index.runs.map((r) => (
                    <button type="button" key={r.name} className={board?.meta.name === r.name ? 'on' : ''} aria-pressed={board?.meta.name === r.name} onClick={() => ctl.selectRun(r.name)}>
                      {r.title}
                    </button>
                  ))}
                </div>
              ) : null}
              {board ? <WatchBand board={board} /> : null}
              {board && !board.record && board.flagsmith && !params.record ? (
                <div className="fsc-hero">
                  <FlagsmithNumbers board={board} small />
                </div>
              ) : null}
            </div>
            {board ? (
              <Board board={board} ctl={ctl} selected={selected} onPick={pick} calm={!playing || reduced} record={params.record || isLive} skeleton={skeleton} />
            ) : (
              <div className="board sk" style={{ minHeight: 560 }} aria-busy="true" aria-label="Loading the run" />
            )}
          </section>
          {board && !board.record && board.flagsmith && !params.record ? (
            <div className="fsc-after">
              <FlagsmithNumbers board={board} small />
            </div>
          ) : null}
          {mode === 'failed' ? <p className="card muted">This run did not load. Pick another run above, or reload the page.</p> : null}
          {board ? (
            <>
              <div id="focus-trace"><FailingAndTrace board={board} selected={selected} onPick={pick} /></div>
              <div id="focus-record"><Record board={board} /></div>
            </>
          ) : null}
          <div id="focus-rule"><AuthorRule {...(board ? { board } : {})} /></div>
          <div id="focus-plug"><PlugIn /></div>
        </main>
        <Footer sources={index ? index.runs.map((r) => r.source).filter((v, i, a) => a.indexOf(v) === i) : []} />
      </div>
    </div>
  );
}
