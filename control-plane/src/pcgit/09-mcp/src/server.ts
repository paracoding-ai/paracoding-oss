/**
 * 09-mcp / server.ts
 *
 * ===========================================================================
 * STREAMABLE HTTP, STATELESS MODE.
 * ===========================================================================
 *
 * Verified against the SDK, not guessed. `@modelcontextprotocol/sdk` 1.30.0
 * (the version `^1.29.0` resolves to), `dist/esm/server/streamableHttp.d.ts`:
 *
 *   // Stateless mode - explicitly set session ID to undefined
 *   const statelessTransport = new StreamableHTTPServerTransport({
 *     sessionIdGenerator: undefined,
 *   });
 *
 * and `webStandardStreamableHttp.d.ts` on `sessionIdGenerator`:
 *
 *   "If not provided, session management is disabled (stateless mode)."
 *
 * with the documented consequences: "In stateless mode: No Session ID is
 * included in any responses; No session validation is performed."
 *
 * The per-request construction below (a fresh `McpServer` AND a fresh
 * transport for every POST, both closed on `res.on('close')`) is the SDK's own
 * stateless example, shipped in the package at
 * `dist/esm/examples/server/simpleStatelessStreamableHttp.js`. Docs:
 * https://ts.sdk.modelcontextprotocol.io/v2/documents/Documents.Server_Guide.html
 * -- "Set `sessionIdGenerator` to a function ... for stateful sessions. Set it
 * to `undefined` for stateless mode (simpler, but does not support
 * resumability)."
 *
 * WHY STATELESS IS NOT OPTIONAL HERE. Cloud Run autoscales, and session
 * affinity is documented as BEST EFFORT: it breaks on instance termination, on
 * max-concurrency, and on max-CPU. Any design that pins an MCP session to an
 * instance is a design that intermittently loses the session mid-conversation
 * and cannot be tested into working. Stateless means any instance can serve
 * any request, so autoscaling and cold starts are invisible to the client.
 *
 * `enableJsonResponse: true` for the same reason: a plain JSON response per
 * POST, no long-lived SSE stream to be severed by a scale-in event. Nothing in
 * this tool surface streams partial results, so there is nothing to lose.
 *
 * The expensive state -- the packfile cache -- is process-local and hoisted to
 * module scope in context.ts. That is not session state: it is a cache of
 * immutable, content-addressed bytes, so an instance that has never seen a
 * request before is merely slower, never wrong.
 *
 * WHAT THIS DOES NOT DO: no auth. Access control is Cloud Run IAM (deploy with
 * `--no-allow-unauthenticated`). Credentials for Firestore and GCS are
 * Application Default Credentials. There is no key material in this repo.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loadConfig, type Config } from './config';
import { getContext, packCacheStats } from './context';
import { buildMcpServer } from './tools';

const MCP_PATH = '/mcp';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

async function handleMcpPost(cfg: Config, req: IncomingMessage, res: ServerResponse) {
  // A NEW McpServer and a NEW transport per request. In stateless mode there
  // is nothing to reuse between requests and reusing a transport would leak
  // one client's in-flight request state into another's.
  const server = buildMcpServer(getContext(cfg));
  try {
    const transport = new StreamableHTTPServerTransport({
      // THE stateless switch. Not a placeholder, not a TODO.
      sessionIdGenerator: undefined,
      // Plain JSON responses instead of an SSE stream: see the header comment.
      enableJsonResponse: true,
    });
    await server.connect(transport);
    // No pre-parsed body is passed, so the transport parses and content-type
    // checks the request itself. There is no body-parser middleware to get out
    // of step with it.
    await transport.handleRequest(req, res);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
  } catch (err) {
    console.error('mcp request failed', err);
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, 'Internal server error');
    } else {
      res.end();
    }
  }
}

export function main(): void {
  // Fail fast and loudly. A container that cannot tell which repository it
  // serves must not start; Cloud Run will surface the crash on deploy.
  const cfg: Config = loadConfig();

  const httpServer = createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (req.method === 'GET' && path === '/health') {
      // Deliberately touches neither Firestore nor GCS. A health check that
      // calls a dependency turns a dependency blip into a rolling restart.
      sendJson(res, 200, {
        status: 'ok',
        service: 'projb-git-mcp',
        version: '1.0.0',
        repoId: cfg.repoId,
        transport: 'streamable-http',
        stateless: true,
        mcpPath: MCP_PATH,
        uptimeSec: Math.round(process.uptime()),
        packCache: packCacheStats(),
      });
      return;
    }

    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: 'not found', endpoints: ['/health', MCP_PATH] });
      return;
    }

    if (req.method === 'POST') {
      void handleMcpPost(cfg, req, res);
      return;
    }

    // In stateless mode there is no standalone SSE stream to open (GET) and no
    // session to terminate (DELETE). Both are 405, per the SDK's own stateless
    // example.
    jsonRpcError(res, 405, -32000, 'Method not allowed.');
  });

  httpServer.listen(cfg.port, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        msg: 'projb-git-mcp listening',
        port: cfg.port,
        repoId: cfg.repoId,
        bucket: cfg.bucket,
        mcpPath: MCP_PATH,
        stateless: true,
      }),
    );
  });

  // Cloud Run sends SIGTERM before reclaiming an instance. Close the listener
  // so in-flight requests finish; the packfile cache dies with the process,
  // which is correct -- it holds nothing that needs flushing.
  process.on('SIGTERM', () => {
    httpServer.close(() => process.exit(0));
  });
}

main();
