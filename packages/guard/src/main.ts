import { ConfigError, loadConfig } from './config.js';
import { systemClock } from './clock.js';
import { createGuardServer } from './http.js';
import { createLogger, makeRedactor } from './log.js';
import { AlibiService } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const redact = makeRedactor(config.secrets);
  const log = createLogger(redact);
  const service = new AlibiService({ config, clock: systemClock(), log, redact });
  await service.start();
  const server = createGuardServer(service, config, log);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  log.info(`alibi guard listening on port ${config.port}, guarding ${config.guard.flag}, switch-off by ${config.flagsmith.switchOff}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close();
    void service.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`alibi-guard: ${error instanceof ConfigError ? message : `could not start: ${message}`}`);
  process.exit(1);
});
