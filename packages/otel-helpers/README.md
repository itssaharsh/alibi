# @alibi/otel-helpers

Two small functions for a Node service that already uses OpenTelemetry and the Flagsmith Node SDK. They are the whole integration Alibi needs from your code.

```js
import { evaluateFlag, runFlagged } from '@alibi/otel-helpers';

// Asks Flagsmith which variation this user gets and writes the answer on the active span
// as a `feature_flag.evaluation` event. Alibi reads the variation there; it never decides one.
const variation = await evaluateFlag({ flagsmith, flag: 'checkout_v2', userId, fallback: 'stable' });

if (variation === 'v2') {
  // Runs the new code inside a span marked `alibi.flagged_path=checkout_v2`.
  // A failure inside that span, or below it, counts as a failure of the feature's own code.
  return runFlagged('checkout_v2', 'checkout_v2', () => newCheckout(cart));
}
return stableCheckout(cart);
```

- `evaluateFlag({ flagsmith, flag, userId, fallback })`: `flagsmith` is a `flagsmith-nodejs` client. The variation is the flag's string value when the flag is on, and `fallback` (your stable value) when the flag is off or Flagsmith could not answer.
- `runFlagged(flag, spanName, fn)`: runs `fn` in a span. An exception is recorded on the span, which is marked as failed, and rethrown. `inSpan(name, attributes, fn)` is the same without the mark.

There is no Flagsmith event or tracking call in your code: Alibi turns the spans into exposures and metrics.

It needs `@opentelemetry/api` (version 1.9 or later) in your service, which any OpenTelemetry setup already has. Install it from this repository with `npm install ../path/to/packages/otel-helpers`, or copy `src/index.js` into your service; it is one file of about 50 lines.
