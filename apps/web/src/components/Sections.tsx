import { useState, type ReactNode } from 'react';
import { formatRelative, stableLevelLabel, type FlatSpan } from '@alibi/core';
import type { Rates } from '@alibi/core';
import type { Board as BoardData, Tag } from '../lib/viewModel';
import { outcomeOf, percent } from '../lib/viewModel';
import type { Controller } from '../lib/useBoard';
import { AUTHORS_RULE, COLLECTOR_CONFIG, HELPER_SNIPPET, REPO_URL, START_COMMAND } from '../lib/copy';
import { classWords, ms, pct, ratesLine, rel, relMs, sig, simplerRules, simplerRulesShort, spanLabel, whyVerdict, type WhyTarget } from '../lib/format';
import type { Scoreboard } from '../lib/scoreboard';
import { videoUrl, type Figures } from '../lib/video';
import { Gloss } from './Gloss';
import { armMarginLine } from '../lib/format';
import { Waterfall } from './Waterfall';
import type { Selected } from '../App';

export function VerdictCard({ board, ctl, skeleton }: { board: BoardData; ctl: Controller; skeleton: boolean }) {
  const o = outcomeOf(board);
  const finished = board.nowMs >= board.endMs - 1 && ctl.mode !== 'playing';
  const flag = board.state.config.flag;
  const failures = Math.max(o.kind === 'waiting' ? 0 : o.failures, board.tags.length);
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
  const after = board.record?.afterSwitchOff;
  const before = board.state.stableBaseline;
  return (
    <div className="verdict" aria-busy={skeleton}>
      {stamp ? (
        <div className={`stamp ${tone} show${o.kind === 'labelled' ? ' label' : ''}`} role="status" key={stamp}>
          {stamp}
          {o.kind === 'labelled' ? <small>Not proven. A person investigates.</small> : null}
        </div>
      ) : null}
      {failures === 0 || skeleton ? (
        <div className="v-line">
          <b>No failures yet</b>
          <span>{simplerRulesShort(board, finished)}</span>
        </div>
      ) : (
        <>
          <div className="big" aria-label={`${o.kind === 'waiting' ? 0 : o.counted} of ${failures}`}>
            {o.kind === 'waiting' ? 0 : o.counted}
            <small> of {failures}</small>
          </div>
          <div className="v-line">
            <b>
              failures counted against <Gloss term="checkout_v2">{flag}</Gloss>
            </b>
            <span>
              {o.kind === 'switching'
                ? `The counter passed ${board.state.config.threshold}. Switching it off in Flagsmith.`
                : o.kind === 'labelled' || o.kind === 'off'
                  ? `Switched off in Flagsmith at ${board.state.switchedOffAtMs !== undefined ? rel(board, board.state.switchedOffAtMs) : ''}.`
                  : simplerRulesShort(board, finished)}
            </span>
          </div>
        </>
      )}
      {o.kind === 'labelled' && o.label === 'probably not the feature' && after && before ? (
        <p className="why-line">
          The flag went off because the feature's own code failed. Afterwards it did not return to the stable level (errors {percent(after.errorRate)} against {percent(before.errorRate)}, <Gloss term="p95">p95</Gloss> {ms(after.p95Ms)} against {ms(before.p95Ms)}), so it was probably not the feature.
        </p>
      ) : null}
    </div>
  );
}

function Level({ title, rates }: { title: string; rates: Rates }) {
  return (
    <div>
      <h4>{title}</h4>
      <dl>
        <dt>errors</dt>
        <dd className="big-n">{percent(rates.errorRate)}</dd>
        <dt>
          <Gloss term="p95">p95</Gloss> speed
        </dt>
        <dd className="big-n">{ms(rates.p95Ms)}</dd>
      </dl>
      <p className="muted small">{ratesLine(rates)}.</p>
    </div>
  );
}

/** Both simpler rules on the same requests, in the engine's words, then what Alibi did. Factual: no rule is made to look worse. */
export function SimplerRules({ board, finished }: { board: BoardData; finished: boolean }) {
  const { rules, alibi, sooner } = simplerRules(board, finished);
  return (
    <div className="simpler" role="group" aria-label="Two simpler rules, same requests">
      <h3>Two simpler rules, same requests</h3>
      {rules.map((r) => (
        <p key={r.key} className={r.tripped ? 'tripped' : ''}>
          {r.at ? <b>{r.at}</b> : null}
          <span>
            {r.key === 'plain' ? <Gloss term="plain error-rate rule">Plain error-rate rule</Gloss> : <Gloss term="arm comparison">Arm comparison</Gloss>}
            {r.text.slice(r.key === 'plain' ? 'Plain error-rate rule'.length : 'Arm comparison'.length)}
          </span>
        </p>
      ))}
      <p className="margin">
        <span>
          {armMarginLine(board.state.config)}
        </span>
      </p>
      <p className="alibi-line">
        <span>
          {alibi}
          {sooner ? ` ${sooner}` : ''}
        </span>
      </p>
      {board.state.notices?.map((n) => (
        <p key={`${n.span}|${n.kind ?? ''}|${n.atMs}`} className="notice">
          <span>Notice: {n.text}</span>
        </p>
      ))}
    </div>
  );
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
        <div className="levels">
          <Level title={stableLevelLabel(state.stableBaselineWindow)} rates={state.stableBaseline} />
          {board.record ? <Level title="After the switch-off" rates={board.record.afterSwitchOff} /> : null}
        </div>
      ) : null}
    </section>
  );
}

export type FailTab = 'counted' | 'excluded' | 'stable';

interface TraceLinks {
  href: (id: string) => string;
  jaeger?: ((id: string) => string) | undefined;
}

function Pager({ tags, selected, onPick, links, chip }: { tags: Tag[]; selected: Selected; onPick: (t: Tag) => void; links: TraceLinks; chip: (t: Tag) => string }) {
  const [shown, setShown] = useState(12);
  return (
    <div className="failing">
      {tags.slice(0, shown).map((t, i) => (
        <a
          key={t.id}
          href={links.href(t.id)}
          className={`f-row${selected.id === t.id ? ' sel' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            onPick(t);
          }}
        >
          <span className={`tag ${t.counted ? 'hot' : 'dep'}`}>
            <span>{i + 1}</span>
          </span>
          <span className="f-text">
            <b>
              {t.id.slice(0, 8)} on {t.route} at {relMs(t.atMs)}
            </b>
            <small>{t.reason}</small>
          </span>
          <em className="chip">{chip(t)}</em>
        </a>
      ))}
      {shown < tags.length ? (
        <button type="button" className="more-btn" onClick={() => setShown(shown + 20)}>
          Show 20 more of {tags.length - shown}
        </button>
      ) : null}
    </div>
  );
}

/** Everything about one request that failed: where, why, and how to point someone at it. */
function OpenTrace({ selected, links }: { selected: Selected; links: TraceLinks }) {
  const [copied, setCopied] = useState(false);
  const tag = selected.tag;
  if (!tag) return <p className="muted">Select a failing request to see its spans.</p>;
  return (
    <>
      <div className="trace-head">
        <p className="muted small">
          {tag.id.slice(0, 8)} on {tag.route}, {ms(tag.durationMs)}
        </p>
        <span className="trace-actions">
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              void navigator.clipboard?.writeText(links.href(tag.id)).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          {links.jaeger ? (
            <a className="link-btn" href={links.jaeger(tag.id)} target="_blank" rel="noreferrer">
              Open in Jaeger
            </a>
          ) : null}
        </span>
      </div>
      <Waterfall spans={selected.spans} loading={selected.loading} origins={tag.origins} />
      <p className="reason">{tag.reason}</p>
    </>
  );
}

const CHIP = (t: Tag): string => (t.counted ? 'counts' : classWords[t.cls]);

export function FailingAndTrace({ board, selected, onPick, tab, setTab, links }: { board: BoardData; selected: Selected; onPick: (t: Tag) => void; tab: FailTab; setTab: (t: FailTab) => void; links: TraceLinks }) {
  const countedAll = board.tags.filter((t) => t.counted).sort((a, b) => a.atMs - b.atMs);
  // The engine counts up to the crossing; failures after it, before the switch-off is confirmed, are shown as a note.
  const counted = countedAll.slice(0, Math.max(board.state.counted, 0) || countedAll.length);
  const after = countedAll.length - counted.length;
  const excluded = board.tags.filter((t) => !t.counted).sort((a, b) => a.atMs - b.atMs);
  const stable = board.stableTags;
  if (board.tags.length === 0 && stable.length === 0) {
    return (
      <section className="card" aria-label="Failing requests">
        <h2>Failing requests</h2>
        <p className="muted">No failing requests yet. Waiting for the first one.</p>
      </section>
    );
  }
  const tabs: { key: FailTab; label: string; n: number }[] = [
    { key: 'counted', label: 'Counted', n: counted.length },
    { key: 'excluded', label: 'Not counted', n: excluded.length },
    { key: 'stable', label: 'Stable version, same period', n: stable.length },
  ];
  const list = tab === 'counted' ? counted : tab === 'excluded' ? excluded : stable;
  return (
    <section className="card two" aria-label="Failing requests and trace">
      <div>
        <h2>Failing requests</h2>
        <div className="tabs" role="tablist" aria-label="Which failing requests">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              {t.label} <b>({t.key === 'stable' ? `${t.n} failed` : t.n})</b>
            </button>
          ))}
        </div>
        <p className="muted small">
          {tab === 'counted'
            ? "Failures in the feature's own code, with the flag on. These count toward the switch-off."
            : tab === 'excluded'
              ? 'Failures with the flag on that happened in a dependency or the server. They do not count, and each says why.'
              : 'Requests of the stable version that failed in the same period, so you can open one that failed at the same span.'}
        </p>
        {list.length === 0 ? <p className="muted">Nothing here.</p> : <Pager key={tab} tags={list} selected={selected} onPick={onPick} links={links} chip={tab === 'stable' ? () => 'stable' : CHIP} />}
        {tab === 'counted' && after > 0 ? <p className="muted small">{after} more failed in the feature's own code while the switch-off was being confirmed.</p> : null}
      </div>
      <div className="sticky">
        <h2>Trace</h2>
        <OpenTrace selected={selected} links={links} />
      </div>
    </section>
  );
}

/** The same failing points in the flag-on and the stable requests, from the engine's baseline. Exists at every moment of every run. */
export function Comparison({ board, onPick, links }: { board: BoardData; onPick: (t: Tag) => void; links: TraceLinks }) {
  const rows = board.record?.baseline ?? board.baseline;
  if (rows.length === 0) return null;
  const flag = board.state.config.flag;
  const example = (list: Tag[], route: string, span: string): Tag | undefined => list.find((t) => t.route === route && t.origins.some((o) => o.name === span));
  return (
    <section className="card compare" aria-label="Compared with the stable version">
      <h2>Compared with the stable version</h2>
      <p className="muted small">The same route and span, flag on against the stable version, over the same period.</p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th className="left">Route and span</th>
              <th>{flag} requests</th>
              <th>failed</th>
              <th>
                <Gloss term="p95">p95</Gloss>
              </th>
              <th>stable requests</th>
              <th>failed</th>
              <th>p95</th>
              <th className="left">Most common reason</th>
              <th className="left">Examples</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const on = example(board.tags, b.route, b.span);
              const off = example(board.stableTags, b.route, b.span);
              return (
                <tr key={`${b.route}${b.span}`}>
                  <td className="mono left">
                    {b.route}, {spanLabel(board, b.route, b.span)}
                    {b.spanExistsInStable ? '' : ' (not in stable, compared at the route)'}
                  </td>
                  <td>{b.flagOn.requests}</td>
                  <td>{b.flagOn.failures}</td>
                  <td>{ms(b.flagOn.p95Ms)}</td>
                  <td>{b.stable.requests}</td>
                  <td>{b.stable.failures}</td>
                  <td>{ms(b.stable.p95Ms)}</td>
                  <td className="why left">{b.why}</td>
                  <td className="left ex">
                    {on ? (
                      <a href={links.href(on.id)} onClick={(e) => { e.preventDefault(); onPick(on); }}>
                        flag on
                      </a>
                    ) : null}
                    {off ? (
                      <a href={links.href(off.id)} onClick={(e) => { e.preventDefault(); onPick(off); }}>
                        stable
                      </a>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Flagsmith's own numbers, as recorded: nothing computed, nothing rounded, absent cells left out. */
export function FlagsmithNumbers({ board, small }: { board: BoardData; small?: boolean }) {
  const f = board.record?.flagsmith ?? board.flagsmith?.data;
  const detail = board.flagsmith?.detail;
  return (
    <div className={small ? 'card fsc' : ''}>
      <h3>Flagsmith's numbers</h3>
      {f ? (
        <>
          <div className="scroll">
            <table className="fs-table">
              <thead>
                <tr>
                  <th className="left">metric</th>
                  {f.variations.map((v) => (
                    <th key={v.variation}>
                      {v.variation}
                      <small>
                        {v.exposures} <Gloss term="exposures">exposures</Gloss>
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...new Set(f.variations.flatMap((v) => v.metrics.map((m) => m.name)))].map((name) => (
                  <tr key={name}>
                    <td className="left">{name.replace(/_/g, ' ')}</td>
                    {f.variations.map((v) => {
                      const m = v.metrics.find((x) => x.name === name);
                      const extra: ReactNode[] = [];
                      if (m) {
                        if (m.lift !== undefined) extra.push(`lift ${pct(m.lift)}`);
                        if (m.chanceToWin !== undefined)
                          extra.push(
                            <>
                              <Gloss term="chance to win">chance to win</Gloss> {pct(m.chanceToWin)}
                            </>,
                          );
                        if (m.interval) extra.push(`interval ${sig(m.interval[0])} to ${sig(m.interval[1])}`);
                      }
                      return (
                        <td key={v.variation} className="fs-cell">
                          {m ? <b>{sig(m.value)}</b> : null}
                          {extra.map((e, i) => (
                            <small key={i}>{e}</small>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small fs-note">
            From Flagsmith Experimentation, {detail ? `${detail} (${rel(board, f.readAtMs)} into the run)` : `read ${rel(board, f.readAtMs)} into the run`}.
          </p>
        </>
      ) : (
        <p className="muted">{board.flagsmithNote ?? "Flagsmith's numbers show here once the experiment has results."}</p>
      )}
    </div>
  );
}

/** "Why this verdict": the author's four-part rule with the engine's numbers, each line a link to its evidence. */
export function WhyVerdict({ board, finished, onGo, hrefFor }: { board: BoardData; finished: boolean; onGo: (t: WhyTarget) => void; hrefFor: (t: WhyTarget) => string }) {
  const lines = whyVerdict(board, finished);
  return (
    <section className="why" aria-label="Why this verdict">
      <h2>Why this verdict</h2>
      <ol>
        {lines.map((l) => (
          <li key={l.n} className={`w${l.n}`}>
            <a
              href={hrefFor(l.target)}
              onClick={(e) => {
                e.preventDefault();
                onGo(l.target);
              }}
            >
              <span className="wn" aria-hidden="true">
                {l.n === 5 ? '!' : l.n}
              </span>
              <span className="wt">
                <b>{l.lead}</b>
                {l.text}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Record({ board, figures }: { board: BoardData; figures?: Figures | undefined }) {
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
      <SimplerRules board={board} finished />
      {r.notices?.length ? (
        <>
          <h3>Notices</h3>
          <ul className="tl">
            {r.notices.map((n) => (
              <li key={`${n.span}|${n.kind ?? ''}|${n.atMs}`}>
                <b>{formatRelative(n.atMs - board.meta.startedAtMs)}</b>
                {n.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
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
          <FlagsmithNumbers board={board} />
          {(figures?.rollout || figures?.results) && (!figures.run || figures.run === board.meta.name) ? (
            <div className="figures">
              {figures.rollout ? (
                <figure>
                  <img src={videoUrl(figures.rollout)} loading="lazy" alt="Flagsmith's experiment page after the switch-off, showing Current rollout 0%" />
                  <figcaption>Flagsmith's own experiment page after the switch-off: Current rollout 0%{figures.run ? ' (a repeat of this run)' : ''}</figcaption>
                </figure>
              ) : null}
              {figures.results ? (
                <figure>
                  <img src={videoUrl(figures.results)} loading="lazy" alt="Flagsmith's results table for the same experiment" />
                  <figcaption>Flagsmith's results table for the same experiment{figures.run ? ' (a repeat of this run)' : ''}</figcaption>
                </figure>
              ) : null}
            </div>
          ) : null}
        </div>
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
          <h3>Put the flag's answer on the span, and run the feature inside a marked span.</h3>
          <pre>{HELPER_SNIPPET}</pre>
          <Copy text={HELPER_SNIPPET} label="Copy snippet" />
        </div>
        <div>
          <h3>Start the example, from the repository root.</h3>
          <pre>{START_COMMAND}</pre>
          <Copy text={START_COMMAND} label="Copy command" />
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

/** The 24 planned outage runs: what was done, the right decision, and how each rule did. Computed from the summary file at build time. */
export function ScoreboardSection({ score }: { score: Scoreboard }) {
  const repo = REPO_URL;
  const cell = (c: { right: number; total: number }, label: string) => {
    const wrong = c.right < c.total;
    return (
      <td className={`score-cell${wrong ? ' wrong' : ''}`} data-label={label}>
        {wrong ? <span aria-label="not always right">✕ </span> : null}
        {c.right} of {c.total}
      </td>
    );
  };
  return (
    <section className="card score" aria-label="How the simpler rules did on the planned runs">
      <h2>{score.headline}</h2>
      <p className="muted small">
        Both rules were scored on the same recorded requests, against what was done to the stack.
        {repo ? (
          <>
            {' '}
            <a href={`${repo}/blob/main/runs/outage-scenarios/PLAN.md`}>The plan, committed first</a>, and <a href={`${repo}/blob/main/runs/outage-scenarios/RESULTS.md`}>every run</a>.
          </>
        ) : null}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th className="left">What was done</th>
              <th className="left">Right decision</th>
              <th>Alibi right</th>
              <th>20-point rule right</th>
            </tr>
          </thead>
          <tbody>
            {score.rows.map((r) => (
              <tr key={r.scenario}>
                <td className="left what">{r.what}</td>
                <td className="left" data-label="Right decision">
                  {r.decision}
                </td>
                {cell(r.alibi, 'Alibi right')}
                {cell(r.rule, '20-point rule right')}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="score-lines">
        {score.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}
