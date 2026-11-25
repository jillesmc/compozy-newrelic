/**
 * Fake NerdGraph for tests and local E2E runs, over plain http on loopback, so a source with
 * `region: loopback:<port>` talks to it (Deviation D-1). It serves `POST /graphql` (and `/eu/graphql`
 * for host-routing tests) and answers the NRQL query shape with the configured rows.
 *
 * In-process (tests):
 *   const nr = await startFakeNerdGraph({ rows: [...] });   // nr.region === "loopback:<port>"
 *   nr.rows = [...]                                         // rows for every NRQL query
 *   nr.issues = [...]; nr.issuePageSize = 2                 // aiIssues answers, paged by nextCursor
 *   nr.requests                                             // { path, headers, body } per request
 *   nr.respond = req => ({ status: 503 })                   // override one or all answers
 *   await nr.close();
 *
 * Standalone (E2E against a live daemon; Node 22+ or Bun):
 *   node test/fake-nerdgraph.ts --port 8788
 *   curl -X POST http://127.0.0.1:8788/_fake/rows -d '[{"facet":"checkout-api","p95":2.31}]'
 *   curl http://127.0.0.1:8788/_fake/rows
 *   curl -X POST http://127.0.0.1:8788/_fake/issues -d '[{"issueId":"i-1","priority":"CRITICAL","state":"ACTIVATED"}]'
 *   # HEARTBEAT.md: with: { account_id: 1234567, region: "loopback:8788", ... }; any NRAK-... key works.
 *
 * Requests without an `API-Key: NRAK-...` header get 401.
 *
 * `POST /mcp/` is the fake official MCP (test/fake-mcp.ts): `nr.mcpFake` in-process, or standalone
 *   node test/fake-nerdgraph.ts --port 8788 --sse          # SSE answers (default JSON)
 *   curl http://127.0.0.1:8788/_fake/mcp                   # mode, pageSize, statuses, tool names
 *   curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"mode":"sse"}'        # or "json"
 *   curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"initStatus":403}'    # MCP unavailable for the key
 *   curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"initStatus":0,"status":0,"expireCalls":1}'
 *   curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"tools":[{"name":"x","annotations":{"readOnlyHint":true}}]}'
 *   curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"holdOpen":true}'     # SSE streams stay open
 *   curl -X POST http://127.0.0.1:8788/_fake/mcp -d '{"reset":true}'        # default catalog and settings
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import { answerMcp, configureFakeMcp, createFakeMcp, type FakeMcp } from "./fake-mcp.ts";

export interface FakeRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: { query?: string; variables?: Record<string, unknown> };
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Hold the answer this long (ms); pending holds end when the fake closes. */
  delayMs?: number;
}

export interface FakeNerdGraph {
  port: number;
  region: `loopback:${number}`;
  rows: Record<string, unknown>[];
  /** aiIssues issues; a query whose text contains `aiIssues` gets a page of these. */
  issues: Record<string, unknown>[];
  issuePageSize: number;
  requests: FakeRequest[];
  respond?: (request: FakeRequest) => FakeResponse | undefined;
  /** Fixed answer of every `POST /mcp/`, bypassing the fake MCP. */
  mcp?: FakeResponse;
  /** The fake official MCP behind `POST /mcp/`. */
  mcpFake: FakeMcp;
  close(): Promise<void>;
}

export async function startFakeNerdGraph(
  options: { rows?: Record<string, unknown>[]; port?: number } = {}
): Promise<FakeNerdGraph> {
  const holds = new Set<() => void>();
  const fake: FakeNerdGraph = {
    port: 0,
    region: "loopback:0",
    rows: [...(options.rows ?? [])],
    issues: [],
    issuePageSize: 50,
    requests: [],
    mcpFake: createFakeMcp(),
    close: async () => {
      for (const release of holds) release();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = req.url ?? "/";
    const send = (status: number, body: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (path === "/_fake/rows") {
      if (req.method === "POST") fake.rows = JSON.parse(raw || "[]");
      return send(200, fake.rows);
    }
    if (path === "/_fake/issues") {
      if (req.method === "POST") fake.issues = JSON.parse(raw || "[]");
      return send(200, fake.issues);
    }
    if (path === "/_fake/mcp") {
      if (req.method === "POST") {
        const update = JSON.parse(raw || "{}");
        if (update.reset) fake.mcpFake = createFakeMcp();
        delete update.reset;
        configureFakeMcp(fake.mcpFake, update);
      }
      const { sessions: _s, requests, tools, ...settings } = fake.mcpFake;
      return send(200, { ...settings, tools: tools.map(tool => tool.name), requests: requests.length });
    }
    let body: FakeRequest["body"];
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(400, { errors: [{ message: "invalid JSON" }] });
    }
    const request: FakeRequest = { path, headers: req.headers, body };
    fake.requests.push(request);
    const wait = (ms: number) =>
      new Promise<void>(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          holds.delete(done);
          resolve();
        }
        holds.add(done);
      });
    const override = fake.respond?.(request);
    if (override) {
      if (override.delayMs) await wait(override.delayMs);
      return send(override.status, override.body ?? "");
    }
    if (path === "/mcp/") {
      if (fake.mcp) return send(fake.mcp.status, fake.mcp.body ?? "");
      return answerMcp(fake.mcpFake, req.headers, raw, res, wait);
    }
    if (req.method !== "POST" || !/^(\/eu)?\/graphql$/.test(path)) return send(404, { errors: [{ message: "not found" }] });
    if (!/^NRAK-\S+$/.test(String(req.headers["api-key"] ?? ""))) return send(401, { errors: [{ message: "unauthorized" }] });
    const id = body.variables?.id;
    if (body.query?.includes("aiIssues")) return send(200, { data: { actor: { account: { id, aiIssues: { issues: issuePage(fake, body.query) } } } } });
    if (body.variables?.ids) return send(200, { data: { actor: { nrql: { results: fake.rows } } } }); // cross-account (D-24)
    send(200, { data: { actor: { account: { id, nrql: { results: fake.rows } } } } });
  });
  await new Promise<void>(resolve => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.region = `loopback:${fake.port}`;
  return fake;
}

/** One aiIssues page: the cursor literal is the offset; `nextCursor` is null on the last page. */
function issuePage(fake: FakeNerdGraph, query: string) {
  const offset = Number(/cursor:"([0-9]+)"/.exec(query)?.[1] ?? 0);
  const end = offset + fake.issuePageSize;
  return { issues: fake.issues.slice(offset, end), nextCursor: end < fake.issues.length ? String(end) : null };
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--port");
  const fake = await startFakeNerdGraph({ port: at >= 0 ? Number(args[at + 1]) : 8788 });
  if (args.includes("--sse")) fake.mcpFake.mode = "sse";
  console.log(`fake NerdGraph listening on http://127.0.0.1:${fake.port}/graphql (region ${fake.region})`);
  console.log(`fake MCP (${fake.mcpFake.mode}) on http://127.0.0.1:${fake.port}/mcp/; settings at /_fake/mcp`);
}
