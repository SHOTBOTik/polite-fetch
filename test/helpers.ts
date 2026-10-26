import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '../src/clock.ts';

/** Часы без настоящего ожидания: sleep двигает время вперёд и запоминает паузу. */
export function fakeClock(start = 0): Clock & { sleeps: number[]; advance(ms: number): void } {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance(ms: number) {
      t += ms;
    },
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export interface LocalServer {
  url: string;
  hits: { method: string; path: string; body: string }[];
  close(): Promise<void>;
}

/** Локальный http-сервер на петлевом адресе со своим обработчиком. Внешней сети тесты не касаются. */
export async function localServer(
  handler: (req: IncomingMessage, res: ServerResponse, n: number) => void,
): Promise<LocalServer> {
  const hits: LocalServer['hits'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body });
      handler(req, res, hits.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
