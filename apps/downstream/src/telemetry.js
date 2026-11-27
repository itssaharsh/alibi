// Starts OpenTelemetry before the server is loaded, so incoming requests get server spans that join the shop's trace.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/healthz' })],
});
sdk.start();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    sdk.shutdown().finally(() => process.exit(0));
  });
}
