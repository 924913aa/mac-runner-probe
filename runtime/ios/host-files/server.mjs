import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { decodeBase64, errorResult, hostError } from './service.mjs';

const maxBody = 2 * 1024 * 1024;

function decodeRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw hostError('HOSTFS_INVALID_REQUEST', 'Expected a JSON object');
  // The CLI base64-encodes paths so spaces, quotes, newlines and Unicode never
  // pass through shell JSON quoting. The model-facing tool uses plain strings.
  for (const key of ['path', 'source', 'destination']) {
    if (request[key + 'Base64'] !== undefined) {
      if (request[key] !== undefined) throw hostError('HOSTFS_INVALID_REQUEST', `Duplicate ${key}`);
      request[key] = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(request[key + 'Base64']));
    }
  }
  return request;
}

export async function openGuestSession(service, { policy, signal }) {
  signal?.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  const secret = Buffer.from('Bearer ' + token);
  const pending = new Set();
  let closed = false, closing;
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000 }, (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (closed || request.method !== 'POST' || request.url !== '/operate' || request.headers.origin !== undefined ||
        supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
      response.writeHead(403).end();
      request.resume();
      return;
    }
    const operation = (async () => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > maxBody) throw hostError('HOSTFS_INVALID_REQUEST', 'Request exceeds 2 MiB');
          chunks.push(chunk);
        }
        if (closed) throw hostError('HOSTFS_SESSION_CLOSED', 'This Linux command has ended');
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw hostError('HOSTFS_INVALID_REQUEST', 'Expected valid JSON'); }
        const args = decodeRequest(parsed);
        const result = await service.execute(args, policy, signal);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        // BusyBox wget preserves business-error bodies on HTTP 200. `ok:false`
        // still becomes a nonzero hostfs exit, including real filesystem errors.
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ok: false, error: errorResult(error) }));
      }
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const close = () => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    closing = (async () => {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
      // Drain filesystem work even when its request socket has been cancelled.
      await Promise.allSettled([...pending]);
    })();
    return closing;
  };
  // The provider's awaited cleanup observes this same promise on every exit.
  const onAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { await close(); signal.throwIfAborted(); }
  return Object.freeze({
    env: Object.freeze({ DSH_HOSTFS_URL: `http://127.0.0.1:${server.address().port}/operate`, DSH_HOSTFS_TOKEN: token }),
    close,
  });
}
