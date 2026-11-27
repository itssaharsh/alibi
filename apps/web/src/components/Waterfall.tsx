import { FLAGGED_PATH_ATTRIBUTE, type FlatSpan, type OriginSpan } from '@alibi/core';
import { waterfallOf } from '../lib/viewModel';
import { classWords } from '../lib/format';

interface Props {
  spans?: FlatSpan[];
  origins: OriginSpan[];
  loading?: boolean;
  compact?: boolean;
}

/** One request's spans as a tree of bars. The failing span is the engine's origin span. */
export function Waterfall({ spans, origins, loading, compact }: Props) {
  if (loading) return <div className="wf sk" style={{ height: compact ? 96 : 150 }} aria-busy="true" aria-label="Loading the trace" />;
  if (!spans || spans.length === 0) return <p className="muted small">The spans of this request are not in this run file.</p>;
  const wf = waterfallOf(spans, origins, FLAGGED_PATH_ATTRIBUTE);
  return (
    <div className={`wf${compact ? ' compact' : ''}`} role="table" aria-label="Spans of the request">
      {wf.rows.map(({ span, depth, origin, flagged }) => {
        const left = ((span.startMs - wf.startMs) / wf.durationMs) * 100;
        const width = Math.max(1.2, (span.durationMs / wf.durationMs) * 100);
        return (
          <div key={span.spanId} role="row" className={`wf-row${origin ? ' origin' : ''}${flagged ? ' flagged' : ''}`}>
            <span role="cell" className="wf-name" style={{ paddingLeft: depth * 14 }}>
              {origin ? <span className="x" aria-label="failing span">✕</span> : null}
              <span className="wf-t">{span.name}</span>
              {origin ? <em className="chip">{classWords[origin.class]}</em> : null}
            </span>
            <span role="cell" className="wf-track">
              <span className="wf-bar" style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
            </span>
            <span role="cell" className="wf-ms">{Math.round(span.durationMs)} ms</span>
          </div>
        );
      })}
    </div>
  );
}
