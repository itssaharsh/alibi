// The only integration code a service needs to work with Alibi.
//
//   evaluateFlag   asks Flagsmith which variation this user gets, and writes the answer on the
//                  active span as a `feature_flag.evaluation` event. Alibi reads the variation
//                  from that event; it never decides a variation itself.
//   runFlagged     runs the code of a flagged feature inside a span carrying
//                  `alibi.flagged_path=<flag>`. A failure anywhere inside that span, or in a
//                  span below it, counts as a failure of the feature's own code.
//
// Both are plain OpenTelemetry. There is no Flagsmith event or exposure call here: exposures
// and metrics are derived from the spans.
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('alibi');

/**
 * Reads the flag for one user. The variation is the flag's value when the flag is on, and
 * `fallback` when the flag is off or Flagsmith could not answer.
 */
export async function evaluateFlag({ flagsmith, flag, userId, fallback }) {
  const flags = await flagsmith.getIdentityFlags(userId);
  const value = flags.getFeatureValue(flag);
  const variation = flags.isFeatureEnabled(flag) && typeof value === 'string' && value !== '' ? value : fallback;
  trace.getActiveSpan()?.addEvent('feature_flag.evaluation', {
    'feature_flag.key': flag,
    'feature_flag.result.variant': variation,
    'feature_flag.context.id': userId,
    'feature_flag.provider.name': 'flagsmith',
  });
  return variation;
}

/** Runs `fn` in a new span. A thrown error is recorded on the span, which is marked as failed. */
export async function inSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Runs the flagged feature's code in a span named `name`, marked as the flag's code path. */
export function runFlagged(flag, name, fn) {
  return inSpan(name, { 'alibi.flagged_path': flag }, fn);
}
