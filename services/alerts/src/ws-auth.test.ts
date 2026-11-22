import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpDataFeed } from '@tickerglass/engine/node';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { feedHeaders, tokenWebSocket } from './ws-auth';

describe('tokenWebSocket', () => {
  it('is not needed without a token', () => {
    expect(tokenWebSocket(null)).toBeUndefined();
  });

  it('sends X-Alerts-Token on the handshake and nothing in the URL', async () => {
    const seen = await new Promise<{ header: string | undefined; url: string | undefined }>(
      (resolve, reject) => {
        const server = createServer();
        server.on('upgrade', (req, socket) => {
          resolve({ header: req.headers['x-alerts-token'] as string | undefined, url: req.url });
          socket.destroy();
          server.close();
        });
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as AddressInfo;
          const WS = tokenWebSocket('t'.repeat(40))!;
          const ws = new WS(loadConfig({ API_URL: `http://127.0.0.1:${port}` }).wsUrl);
          ws.onerror = () => {};
        });
        setTimeout(() => reject(new Error('no handshake')), 5000);
      },
    );
    expect(seen.header).toBe('t'.repeat(40));
    expect(seen.url).toBe('/ws');
  });
});

describe('feedHeaders', () => {
  const seen = async (token: string | null) => {
    let headers: Headers | null = null;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const feed = new HttpDataFeed({ baseUrl: 'http://x', fetchImpl, headers: feedHeaders(token) });
    await feed.resolveSymbol('AAPL').catch(() => undefined);
    feed.dispose();
    return headers as Headers | null;
  };

  it('puts the token on the feed HTTP requests when configured', async () => {
    const h = await seen('tok-123');
    expect(h?.get('x-alerts-token')).toBe('tok-123');
    expect(h?.get('x-tickerglass-priority')).toBe('visible');
  });

  it('adds no token header without a token', async () => {
    const h = await seen(null);
    expect(h?.get('x-alerts-token')).toBeNull();
    expect(h?.get('x-tickerglass-priority')).toBe('visible');
  });
});
