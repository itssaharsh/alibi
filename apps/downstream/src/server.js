// The two small services the outage scenarios add to the example. SERVICE=tax answers a tax rate for every checkout;
// SERVICE=rules answers price rules to the new checkout. Both answer at once, so a stopped service is the only fault.
import { createServer } from 'node:http';

const service = process.env.SERVICE;
const answers = {
  tax: { path: '/tax', body: { rate: 0.08, region: 'default' } },
  rules: { path: '/rules', body: { rules: [{ id: 'bundle', percent: 0 }] } },
};
const answer = answers[service];
if (!answer) {
  console.error('SERVICE must be tax or rules');
  process.exit(1);
}

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  } else if (path === answer.path) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  } else {
    res.writeHead(404).end();
  }
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`${service} listening`));
