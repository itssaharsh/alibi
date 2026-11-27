// Starts OpenTelemetry before anything else is loaded, so http, express and pg are patched.
// Loaded with `node --import ./src/telemetry.js`. It exports over OTLP/HTTP to the collector
// named by OTEL_EXPORTER_OTLP_ENDPOINT, under the service name in OTEL_SERVICE_NAME.
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

// The shop is an ES module, so imported packages are only patched once this loader hook is registered.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    new HttpInstrumentation({
      // Health checks are not shop traffic.
      ignoreIncomingRequestHook: (req) => req.url === '/healthz',
    }),
    new ExpressInstrumentation(),
    new PgInstrumentation(),
  ],
});

sdk.start();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    sdk.shutdown().finally(() => process.exit(0));
  });
}
