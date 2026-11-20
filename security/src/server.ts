import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { RiskEngine } from './risk-engine.ts';

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Creates a standalone HTTP security microservice exposing the frozen
 * RiskDecision API contract, queue-grant issuance, and audit inspection.
 */
export function createSecurityServer(engine: RiskEngine = new RiskEngine()): http.Server {
  return http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (method === 'GET' && urlPath === '/health') {
        sendJson(res, 200, { ok: true, stats: engine.getStats() });
        return;
      }

      if (method === 'GET' && urlPath === '/audit') {
        sendJson(res, 200, {
          ok: true,
          stats: engine.getStats(),
          decisions: engine.getAuditLog(),
        });
        return;
      }

      if (method === 'POST' && urlPath === '/evaluate') {
        const body = await readJsonBody(req);
        const decision = engine.evaluate(body);
        sendJson(res, 200, decision);
        return;
      }

      if (method === 'POST' && urlPath === '/sales/configure') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const eventSaleId = typeof body.eventSaleId === 'string' ? body.eventSaleId.trim() : '';
        if (!eventSaleId) {
          sendJson(res, 400, { ok: false, error: 'eventSaleId is required' });
          return;
        }
        engine.configureSale(eventSaleId, {
          capacity: typeof body.capacity === 'number' ? body.capacity : undefined,
          holdTtlMs: typeof body.holdTtlMs === 'number' ? body.holdTtlMs : undefined,
          maxActiveHoldsPerAccount:
            typeof body.maxActiveHoldsPerAccount === 'number' ? body.maxActiveHoldsPerAccount : undefined,
          maxActiveHoldsPerCluster:
            typeof body.maxActiveHoldsPerCluster === 'number' ? body.maxActiveHoldsPerCluster : undefined,
          maxTicketsPerAccount:
            typeof body.maxTicketsPerAccount === 'number' ? body.maxTicketsPerAccount : undefined,
          maxTicketsPerCluster:
            typeof body.maxTicketsPerCluster === 'number' ? body.maxTicketsPerCluster : undefined,
          requireQueueGrants:
            typeof body.requireQueueGrants === 'boolean' ? body.requireQueueGrants : undefined,
        });
        const saleState = engine.getSaleState(eventSaleId);
        sendJson(res, 200, {
          ok: true,
          eventSaleId,
          capacity: saleState.capacity,
          availableInventory: saleState.availableInventory,
          requireQueueGrants: engine.expediting.isGrantRequired(eventSaleId),
        });
        return;
      }

      if (method === 'POST' && urlPath === '/grants/issue') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const eventSaleId = typeof body.eventSaleId === 'string' ? body.eventSaleId.trim() : '';
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!eventSaleId || !accountId || !sessionId) {
          sendJson(res, 400, { ok: false, error: 'eventSaleId, accountId, and sessionId are required' });
          return;
        }
        const issuedAtMs = typeof body.issuedAtMs === 'number' ? body.issuedAtMs : Date.now();
        const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : 300_000;
        const queueGrant = engine.issueQueueGrant({
          eventSaleId,
          accountId,
          sessionId,
          issuedAtMs,
          ttlMs,
        });
        sendJson(res, 200, { ok: true, queueGrant, expiresAtMs: issuedAtMs + ttlMs });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown route: ${method} ${urlPath}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.SECURITY_PORT || 4100);
  const host = process.env.SECURITY_HOST || '127.0.0.1';
  const server = createSecurityServer();
  server.listen(port, host, () => {
    console.log(JSON.stringify({ ok: true, service: 'fairtickets-security', url: `http://${host}:${port}` }));
  });
}
