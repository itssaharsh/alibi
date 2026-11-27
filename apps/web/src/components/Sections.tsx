import { useState } from 'react';
import { formatRelative, stableLevelLabel, type FlatSpan } from '@alibi/core';
import type { Board as BoardData, Tag } from '../lib/viewModel';
import { outcomeOf } from '../lib/viewModel';
import type { Controller } from '../lib/useBoard';
import { AUTHORS_RULE, COLLECTOR_CONFIG, REPO_URL, SPAN_ATTRIBUTES } from '../lib/copy';
import { classWords, ms, ratesLine, rel, relMs } from '../lib/format';
import { Waterfall } from './Waterfall';
import type { Selected } from '../App';

export function VerdictCard({ board, ctl, skeleton }: { board: BoardData; ctl: Controller; skeleton: boolean }) {
  const o = outcomeOf(board);
  const finished = board.nowMs >= board.endMs - 1 && ctl.mode !== 'playing';
  const flag = board.state.config.flag;
  let stamp = '';
  let tone = 'ok';
  if (o.kind === 'on') stamp = finished ? 'Flag stays on' : 'Flag is on';
  if (o.kind === 'switching') {
    stamp = 'Switching off';
    tone = 'warn';
  }
  if (o.kind === 'off') {
    stamp = 'Switched off';
    tone = 'warn';
  }
  if (o.kind === 'labelled') {
    stamp = o.label;
    tone = o.label === 'probably the feature' ? 'warn' : 'neutral';
  }
  return (
    <div className="verdict" aria-busy={skeleton}>
      {stamp ? (
        <div className={`stamp ${tone} show${o.kind === 'labelled' ? ' label' : ''}`} role="status" key={stamp}>
          {stamp}
          {o.kind === 'labelled' ? <small>Not proven. A person investigates.</small> : null}
        </div>
      ) : null}
      {o.kind === 'waiting' || skeleton ? (
        <div className="v-line">
          <b>Waiting for the first failing request.</b>
        </div>
      ) : (
        <>
          <div className="big" aria-label={`${o.counted} of ${o.failures}`}>
            {o.counted}
            <small> of {o.failures}</small>
          </div>
          <div className="v-line">
            <b>failures counted against {flag}</b>
            <span>{o.kind === 'switching' ? `The counter passed ${board.state.config.threshold}. Switching it off in Flagsmith.` : o.kind === 'labelled' || o.kind === 'off' ? `Switched off in Flagsmith at ${board.state.switchedOffAtMs !== undefined ? rel(board, board.state.switchedOffAtMs) : ''}.` : plainSentence(board, finished)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function plainSentence(board: BoardData, finished: boolean): string {
  const t = board.state.plainRuleTrippedAtMs;
  if (t !== undefined) return `A plain error-rate rule would have switched it off at ${rel(board, t)}.`;
  return finished ? 'A plain error-rate rule would not have switched it off.' : 'A plain error-rate rule is watching the same requests.';
}

export function WatchBand({ board }: { board: BoardData }) {
  const { state } = board;
  if (state.phase === 'armed' || state.switchedOffAtMs === undefined || state.watchEndsAtMs === undefined) return null;
  const abs = board.meta.startedAtMs + board.nowMs;
  const total = state.watchEndsAtMs - state.switchedOffAtMs;
  const done = Math.max(0, Math.min(1, (abs - state.switchedOffAtMs) / total));
  const left = Math.max(0, Math.ceil((state.watchEndsAtMs - abs) / 1000));
  const minutes = state.config.watchMs / 60000;
  const recovered = state.recoveredAtMs !== undefined;
  const answer = board.moments.find((m) => m.key === 'switched-off' && m.confirmed)?.detail;
  let line = `Watching for ${minutes} minutes.`;
  if (recovered) line = `Error rate and speed are back at the stable version's level at ${rel(board, state.recoveredAtMs as number)}.`;
  else if (state.label) line = `Still above the stable version's level after ${minutes} minutes.`;
  return (
    <section className="card watch" aria-label="The watch after the switch-off">
      <div className="rec-head">
        <h2>The {minutes}-minute watch</h2>
        {state.label ? null : <span className="countdown" role="timer" aria-label="Time left in the watch">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left</span>}
      </div>
      <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)} aria-label="Watch progress">
        <span style={{ width: `${done * 100}%` }} />
        {recovered ? <i style={{ left: `${(((state.recoveredAtMs as number) - state.switchedOffAtMs) / total) * 100}%` }} title="Back at the stable level" /> : null}
      </div>
      <p className="w-line">{line}</p>
      {answer ? <p className="muted small">Flagsmith: {answer}.</p> : null}
      {state.stableBaseline ? (
        <p className="muted small">
          {stableLevelLabel(state.stableBaselineWindow)}: {ratesLine(state.stableBaseline)}.
        </p>
      ) : null}
      {board.record ? <p className="muted small">After the switch-off: {ratesLine(board.record.afterSwitchOff)}.</p> : null}
    </section>
  );
}

function Pager({ tags, selected, onPick }: { tags: Tag[]; selected: Selected; onPick: (t: Tag) => void }) {
  const [shown, setShown] = useState(12);
  const sorted = [...tags].sort((a, b) => Number(b.counted) - Number(a.counted) || a.atMs - b.atMs);
  return (
    <div className="failing">
      {sorted.slice(0, shown).map((t, i) => (
        <button type="button" key={t.id} className={`f-row${selected.id === t.id ? ' sel' : ''}`} onClick={() => onPick(t)}>
          <span className={`tag ${t.counted ? 'hot' : 'dep'}`}>
            <span>{i + 1}</span>
          </span>
          <span className="f-text">
            <b>
              {t.id.slice(0, 8)} on {t.route} at {relMs(t.atMs)}
            </b>
            <small>{t.reason}</small>
          </span>
          <em className="chip">{t.counted ? 'counts' : classWords[t.cls]}</em>
        </button>
      ))}
      {shown < sorted.length ? (
        <button type="button" className="more-btn" onClick={() => setShown(shown + 20)}>
          Show 20 more of {sorted.length - shown}
        </button>
      ) : null}
    </div>
  );
}

export function FailingAndTrace({ board, selected, onPick }: { board: BoardData; selected: Selected; onPick: (t: Tag) => void }) {
  if (board.tags.length === 0) {
    return (
      <section className="card" aria-label="Failing requests">
        <h2>Failing requests</h2>
        <p className="muted">No failing requests yet. Waiting for the first one.</p>
      </section>
    );
  }
  return (
    <section className="card two" aria-label="Failing requests and trace">
      <div>
        <h2>Failing requests</h2>
        <p className="muted small">Only requests with the flag on. Counted ones first.</p>
        <Pager tags={board.tags} selected={selected} onPick={onPick} />
      </div>
      <div className="sticky">
        <h2>Trace</h2>
        {selected.tag ? (
          <>
            <p className="muted small">
              {selected.tag.id.slice(0, 8)} on {selected.tag.route}, {ms(selected.tag.durationMs)}
            </p>
            <Waterfall spans={selected.spans} loading={selected.loading} origins={selected.tag.origins} />
            <p className="reason">{selected.tag.reason}</p>
          </>
        ) : (
          <p className="muted">Select a failing request to see its spans.</p>
        )}
      </div>
    </section>
  );
}

export function Record({ board }: { board: BoardData }) {
  const r = board.record;
  if (!r) return null;
  const f = r.flagsmith;
  return (
    <section className="card record" aria-label="Investigation record">
      <div className="rec-head">
        <h2>Investigation record</h2>
        <span className="muted small">{r.id}</span>
      </div>
      <p className="rec-label">
        <b>{r.label}</b>, not proven. {r.nextStep}
      </p>
      <div className="cols">
        <div>
          <h3>Timeline</h3>
          <ul className="tl">
            {r.timeline.map((e, i) => (
              <li key={i}>
                <b>{formatRelative(e.atMs - board.meta.startedAtMs)}</b>
                {e.text}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Flagsmith's numbers</h3>
          {f ? (
            <div className="fs">
              {f.variations.map((v) => (
                <div key={v.variation}>
                  <span className="muted small">{v.variation}</span>
                  <b>{v.exposures.toLocaleString('en')}</b> <span className="muted small">exposures</span>
                  <ul>
                    {v.metrics.map((m) => (
                      <li key={m.name}>
                        {m.name.replace(/_/g, ' ')}: {m.value}
                        {m.lift !== undefined ? `, lift ${m.lift}` : ''}
                        {m.chanceToWin !== undefined ? `, chance to win ${m.chanceToWin}` : ''}
                        {m.interval ? `, interval ${m.interval[0]} to ${m.interval[1]}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="muted small fs-note">From Flagsmith Experimentation, read {rel(board, f.readAtMs)} into the run.</p>
            </div>
          ) : (
            <p className="muted">Flagsmith's numbers show here once the experiment has results.</p>
          )}
        </div>
      </div>
      <h3>Compared with the stable version</h3>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Route and span</th>
              <th>{r.flag} requests</th>
              <th>failed</th>
              <th>p95</th>
              <th>stable requests</th>
              <th>failed</th>
              <th>p95</th>
              <th className="left">Most common reason</th>
            </tr>
          </thead>
          <tbody>
            {r.baseline.map((b) => (
              <tr key={`${b.route}${b.span}`}>
                <td className="mono left">
                  {b.route}, {b.span}
                  {b.spanExistsInStable ? '' : ' (not in stable, compared at the route)'}
                </td>
                <td>{b.flagOn.requests}</td>
                <td>{b.flagOn.failures}</td>
                <td>{ms(b.flagOn.p95Ms)}</td>
                <td>{b.stable.requests}</td>
                <td>{b.stable.failures}</td>
                <td>{ms(b.stable.p95Ms)}</td>
                <td className="why left">{b.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AuthorRule({ board }: { board?: BoardData }) {
  const t = board?.state.config.tolerance;
  return (
    <section className="card rule" aria-label="The author's rule">
      <h2>The author's rule</h2>
      <p className="muted small">In his words. Alibi does exactly this.</p>
      <ol>
        {AUTHORS_RULE.map((p) => (
          <li key={p}>
            <q>{p}</q>
          </li>
        ))}
      </ol>
      {t ? (
        <p className="muted small">
          Where the rule leaves room, these are the tool's defaults, not his: "back at the stable level" means, over the last {t.windowMs / 1000} seconds with at least {t.minRequests} requests, an error rate within {t.errorRatePoints}{' '}
          points of the stable version's and p95 latency within {t.p95Factor} times its own.
        </p>
      ) : null}
    </section>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function PlugIn() {
  return (
    <section className="card plug" aria-label="How to plug it in">
      <h2>Plug it in</h2>
      <div className="steps">
        <div>
          <h3>Point your OpenTelemetry Collector at Alibi.</h3>
          <pre>{COLLECTOR_CONFIG}</pre>
          <Copy text={COLLECTOR_CONFIG} label="Copy config" />
        </div>
        <div>
          <h3>Stamp each request with its flag.</h3>
          <pre>{SPAN_ATTRIBUTES}</pre>
          <Copy text={SPAN_ATTRIBUTES} label="Copy attributes" />
        </div>
        <div>
          <h3>Start the example.</h3>
          <pre>docker compose up</pre>
          <Copy text="docker compose up" label="Copy command" />
        </div>
      </div>
    </section>
  );
}

export function Footer({ sources }: { sources: string[] }) {
  return (
    <footer>
      <p>
        What's real: Flagsmith, the flag, the switch-off, the spans and the failures are real and recorded; the shop and its customers are scripted.
        {REPO_URL ? (
          <>
            {' '}
            <a href={REPO_URL}>Read the README</a>.
          </>
        ) : null}
      </p>
      {sources.length ? <p className="muted small">Runs: {sources.join(', ')}</p> : null}
    </footer>
  );
}

export type { FlatSpan };
