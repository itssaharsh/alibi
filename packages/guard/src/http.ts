import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { OtlpError } from '@alibi/core';
import type { ServiceConfig } from './config.js';
import type { Logger } from './log.js';
import { ArmRefused, type AlibiService, type StreamEvent } from './service.js';
import { RECORD_ID } from './store.js';

const gunzipAsync = promisify(gunzip);
const SSE_HEARTBEAT_MS = 15000;
const SSE_STATE_MS = 2000;
const SSE_BACKLOG_BYTES = 4 * 1024 * 1024;
const SMALL_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...CORS, ...extra });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), 'application/json');

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'the body is too large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    total += part.length;
    if (total > limit) throw new HttpError(413, 'the body is too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'the body is not valid JSON');
  }
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createGuardServer(service: AlibiService, config: ServiceConfig, log: Logger): Server {
  const authorised = (req: IncomingMessage): boolean => {
    if (!config.controlToken) return true;
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const direct = req.headers['x-alibi-token'];
    return sameToken(bearer ?? (typeof direct === 'string' ? direct : undefined), config.controlToken);
  };

  const traces = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (type !== undefined && type !== 'application/json') {
      throw new HttpError(415, 'send OTLP as JSON (set encoding: json on the otlphttp exporter)');
    }
    let body = await readBody(req, config.maxBodyBytes);
    const encoding = req.headers['content-encoding']?.trim().toLowerCase();
    if (encoding === 'gzip') {
      try {
        body = await gunzipAsync(body, { maxOutputLength: config.maxBodyBytes });
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new HttpError(413, 'the body is too large');
        throw new HttpError(400, 'the body is not valid gzip');
      }
    } else if (encoding !== undefined && encoding !== 'identity') {
      throw new HttpError(415, 'only gzip or no content encoding is accepted');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'the body is not valid JSON');
    }
    try {
      service.receiveOtlp(parsed);
    } catch (error) {
      if (error instanceof OtlpError) throw new HttpError(400, error.message);
      throw error;
    }
    json(res, 200, {});
  };

  const events = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS,
    });
    res.write('retry: 3000\n\n');
    const write = (name: string, data: unknown): void => {
      if (res.writableLength > SSE_BACKLOG_BYTES) {
        res.destroy();
        return;
      }
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const snapshot = (): void => write('state', service.state({ recent: false }));
    snapshot();
    const unsubscribe = service.subscribe((event: StreamEvent) => write(event.type, event));
    const state = setInterval(snapshot, SSE_STATE_MS);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      unsubscribe();
      clearInterval(state);
      clearInterval(heartbeat);
    });
  };

  const records = async (path: string, res: ServerResponse): Promise<void> => {
    if (path === '/api/records') return json(res, 200, service.listRecords());
    const name = decodeURIComponent(path.slice('/api/records/'.length));
    const markdown = name.endsWith('.md');
    const id = markdown ? name.slice(0, -3) : name.endsWith('.json') ? name.slice(0, -5) : name;
    if (!RECORD_ID.test(id)) throw new HttpError(404, 'no such record');
    const body = markdown ? await service.readRecordMarkdown(id) : await service.readRecordJson(id);
    if (body === undefined) throw new HttpError(404, 'no such record');
    send(res, 200, body, markdown ? 'text/markdown; charset=utf-8' : 'application/json');
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '600' });
      res.end();
      return;
    }
    if (path === '/v1/traces') {
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      try {
        return await traces(req, res);
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) service.noteMalformed();
        throw error;
      }
    }
    if (path === '/api/world' || path === '/api/arm') {
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      if (!authorised(req)) throw new HttpError(401, 'the control token is missing or wrong');
      const body = await readJson(req, SMALL_BODY_BYTES);
      const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
      if (!fields) throw new HttpError(400, 'send a JSON object');
      if (path === '/api/world') {
        if (typeof fields.text !== 'string' || fields.text.trim() === '' || fields.text.length > 500) {
          throw new HttpError(400, 'text must be a sentence of up to 500 characters');
        }
        service.addWorld(fields.text.trim());
        return json(res, 200, { ok: true });
      }
      for (const key of ['name', 'title', 'planted'] as const) {
        if (fields[key] !== undefined && (typeof fields[key] !== 'string' || fields[key] === '')) throw new HttpError(400, `${key} must be text`);
      }
      if (fields.force !== undefined && typeof fields.force !== 'boolean') throw new HttpError(400, 'force must be true or false');
      try {
        const options: Parameters<AlibiService['arm']>[0] = {};
        if (typeof fields.name === 'string') options.name = fields.name;
        if (typeof fields.title === 'string') options.title = fields.title;
        if (typeof fields.planted === 'string') options.planted = fields.planted;
        if (typeof fields.force === 'boolean') options.force = fields.force;
        return json(res, 200, { ok: true, run: await service.arm(options) });
      } catch (error) {
        if (error instanceof ArmRefused) throw new HttpError(409, error.message);
        throw error;
      }
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'use GET');
    if (path === '/healthz') return send(res, 200, `ok ${service.phase}\n`, 'text/plain; charset=utf-8');
    if (path === '/api/state') return json(res, 200, service.state());
    if (path === '/api/events') return events(req, res);
    if (path === '/api/records' || path.startsWith('/api/records/')) return records(path, res);
    if (path.startsWith('/api/traces/')) {
      const spans = service.trace(decodeURIComponent(path.slice('/api/traces/'.length)));
      if (!spans) throw new HttpError(404, 'that trace is not kept (only the last 500 failing traces are)');
      return json(res, 200, spans);
    }
    throw new HttpError(404, 'not found');
  };

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.message });
        if (error.status === 413) req.destroy();
        return;
      }
      log.warn(`a request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      json(res, 500, { error: 'internal error' });
    });
  });
}
