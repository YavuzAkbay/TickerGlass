/**
 * WebSocket constructor that sends the alerts token as an `X-Alerts-Token` header on the
 * handshake. Node's built-in WebSocket (undici) accepts `{ headers }` as its second argument;
 * the browser typings do not know it. The token no longer rides in the URL, so it never shows
 * up in the API's or a reverse proxy's access log.
 */
export function tokenWebSocket(token: string | null): typeof WebSocket | undefined {
  if (!token) return undefined;
  const Base = globalThis.WebSocket as unknown as new (
    url: string | URL,
    init: { headers: Record<string, string> },
  ) => WebSocket;
  class TokenWebSocket extends Base {
    constructor(url: string | URL) {
      super(url, { headers: { 'X-Alerts-Token': token as string } });
    }
  }
  return TokenWebSocket as unknown as typeof WebSocket;
}

/**
 * Headers for the HttpDataFeed's HTTP requests (bars, symbols). Besides the visible-chart priority
 * they carry `X-Alerts-Token` when configured: with API auth on, the API answers 401 without it.
 */
export function feedHeaders(token: string | null): Record<string, string> {
  return {
    'X-TickerGlass-Priority': 'visible',
    ...(token ? { 'X-Alerts-Token': token } : {}),
  };
}
