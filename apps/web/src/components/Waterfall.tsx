import { useState } from 'react';
import { FLAGGED_PATH_ATTRIBUTE, type FlatSpan, type OriginSpan } from '@alibi/core';
import { waterfallOf } from '../lib/viewModel';
import { classWords, ms } from '../lib/format';

interface Props {
  spans?: FlatSpan[];
  origins: OriginSpan[];
  loading?: boolean;
  compact?: boolean;
}

/**
 * One request's spans as a tree of bars. The failing span is the engine's origin span. Middleware and
 * pool connects are folded away unless they sit on the way to the failing span or on the flagged path.
 */
export function Waterfall({ spans, origins, loading, compact }: Props) {
  const [all, setAll] = useState(false);
  if (loading) return <div className="wf sk" style={{ height: compact ? 96 : 150 }} aria-busy="true" aria-label="Loading the trace" />;
  if (!spans || spans.length === 0) return <p className="muted small">The spans of this request are not in this run file.</p>;
  const wf = waterfallOf(spans, origins, FLAGGED_PATH_ATTRIBUTE);
  const hidden = wf.rows.filter((r) => r.quiet).length;
  const rows = all ? wf.rows : wf.rows.filter((r) => !r.quiet);
  return (
    <div>
      <div className={`wf${compact ? ' compact' : ''}`} role="table" aria-label="Spans of the request">
        {rows.map(({ span, depth, origin, flagged }) => {
          const left = ((span.startMs - wf.startMs) / wf.durationMs) * 100;
          const width = Math.max(1.2, (span.durationMs / wf.durationMs) * 100);
          return (
            <div key={span.spanId} role="row" className={`wf-row${origin ? ' origin' : ''}${flagged ? ' flagged' : ''}`}>
              <span role="cell" className="wf-name" style={{ paddingLeft: Math.min(depth, 6) * 12 }}>
                {origin ? <span className="x" aria-label="failing span">✕</span> : null}
                <span className="wf-t">{span.name}</span>
                {origin ? <em className="chip">{classWords[origin.class]}</em> : null}
              </span>
              <span role="cell" className="wf-track">
                <span className="wf-bar" style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
              </span>
              <span role="cell" className="wf-ms">{ms(span.durationMs)}</span>
            </div>
          );
        })}
      </div>
      {hidden > 0 ? (
        <button type="button" className="wf-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? `Hide ${hidden} quiet spans` : `Show all ${wf.rows.length} spans`}
        </button>
      ) : null}
    </div>
  );
}
