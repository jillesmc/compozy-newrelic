/**
 * Fake NerdGraph for tests and local E2E runs, over plain http on loopback, so a source with
 * `region: loopback:<port>` talks to it (Deviation D-1). It serves `POST /graphql` (and `/eu/graphql`
 * for host-routing tests) and answers the NRQL query shape with the configured rows.
 *
 * In-process (tests):
 *   const nr = await startFakeNerdGraph({ rows: [...] });   // nr.region === "loopback:<port>"
 *   nr.rows = [...]                                         // rows for every NRQL query
 *   nr.requests                                             // { path, headers, body } per request
 *   nr.respond = req => ({ status: 503 })                   // override one or all answers
 *   await nr.close();
 *
 * Standalone (E2E against a live daemon; Node 22+ or Bun):
 *   node test/fake-nerdgraph.ts --port 8788
 *   curl -X POST http://127.0.0.1:8788/_fake/rows -d '[{"facet":"checkout-api","p95":2.31}]'
 *   curl http://127.0.0.1:8788/_fake/rows
 *   # HEARTBEAT.md: with: { account_id: 1234567, region: "loopback:8788", ... }; any NRAK-... key works.
 *
 * Requests without an `API-Key: NRAK-...` header get 401.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

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
  requests: FakeRequest[];
  respond?: (request: FakeRequest) => FakeResponse | undefined;
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
    requests: [],
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
    let body: FakeRequest["body"];
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(400, { errors: [{ message: "invalid JSON" }] });
    }
    const request: FakeRequest = { path, headers: req.headers, body };
    fake.requests.push(request);
    const override = fake.respond?.(request);
    if (override) {
      if (override.delayMs) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, override.delayMs);
          function done() {
            clearTimeout(timer);
            holds.delete(done);
            resolve();
          }
          holds.add(done);
        });
      }
      return send(override.status, override.body ?? "");
    }
    if (req.method !== "POST" || !/^(\/eu)?\/graphql$/.test(path)) return send(404, { errors: [{ message: "not found" }] });
    if (!/^NRAK-\S+$/.test(String(req.headers["api-key"] ?? ""))) return send(401, { errors: [{ message: "unauthorized" }] });
    const id = body.variables?.id;
    send(200, { data: { actor: { account: { id, nrql: { results: fake.rows } } } } });
  });
  await new Promise<void>(resolve => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.region = `loopback:${fake.port}`;
  return fake;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--port");
  const fake = await startFakeNerdGraph({ port: at >= 0 ? Number(args[at + 1]) : 8788 });
  console.log(`fake NerdGraph listening on http://127.0.0.1:${fake.port}/graphql (region ${fake.region})`);
}
