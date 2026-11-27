export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

/** Replaces every secret in the text. Secrets shorter than 6 characters are ignored so a short word is not blanked out. */
export function makeRedactor(secrets: readonly string[]): (text: string) => string {
  const list = secrets.filter((secret) => secret.length >= 6).sort((a, b) => b.length - a.length);
  return (text) => list.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

export function createLogger(redact: (text: string) => string, write: (line: string) => void = (line) => console.log(line)): Logger {
  return {
    info: (message) => write(redact(message)),
    warn: (message) => write(redact(`warning: ${message}`)),
  };
}
