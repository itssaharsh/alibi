/** The author's rule, his words (27 Nov 2026), verbatim from the implementation contract. */
export const AUTHORS_RULE: readonly string[] = [
  "Only failures in the feature's own code path count. If a request fails because the server or a dependency is down, that is an infrastructure problem, not the feature, and it does not count toward a rollback. Classify every failing trace by where it failed (a span on the flagged path, or an infrastructure or dependency span) and show why.",
  'Switch the flag off when more than 15 requests with the flag on have failed on the flagged path.',
  'The baseline is the previous stable version: compare its metrics at the same failing points (same routes and spans), and show why each one failed.',
  "After switching off: if error rate and latency return to the previous stable version's level within 5 minutes, label it 'probably the feature', not proven, and open an investigation record with the traces. If they do not recover within 5 minutes, label it 'probably not the feature'. Either way a person investigates; the system never declares the cause on its own.",
];

/** The three copyable blocks of "Plug it in". They are the README's own text; a test compares them with it. */
export const START_COMMAND = 'docker compose -f deploy/docker-compose.yml up -d --build --wait';

export const COLLECTOR_CONFIG = `exporters:
  otlphttp/alibi:
    endpoint: http://alibi:4319
    encoding: json
service:
  pipelines:
    traces:
      exporters: [otlp/jaeger, otlphttp/alibi]`;

export const HELPER_SNIPPET = `const variation = await evaluateFlag({ flagsmith, flag: 'checkout_v2', userId, fallback: 'stable' });
if (variation === 'v2') {
  return runFlagged('checkout_v2', 'checkout_v2', () => newCheckout(cart));
}
return stableCheckout(cart);`;

export const REPO_URL: string | undefined = (import.meta.env.VITE_REPO_URL as string | undefined) || undefined;
