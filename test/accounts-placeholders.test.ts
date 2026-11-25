import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { NRQL_CROSS_QUERY, NRQL_QUERY } from "../src/nerdgraph.ts";
import { createPollHandler } from "../src/poll.ts";
import { SOURCES } from "../src/sources/index.ts";
import type { SourceDefinition } from "../src/sources/source.ts";
import { toolHandler, TOOLS } from "../src/tools/index.ts";
import { decodeToolError, FAKE_KEY, pollRequest, rejection } from "./helpers.ts";

const roots: string[] = [];
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

function workspace(toml?: string): string {
  const root = mkdtempSync(join(tmpdir(), "nr-d24-"));
  roots.push(root);
  if (toml !== undefined) {
    mkdirSync(join(root, ".compozy"));
    writeFileSync(join(root, ".compozy", "newrelic.toml"), toml);
  }
  return root;
}

const source = (kind: string) => SOURCES.find(entry => entry.kind === kind)! as SourceDefinition;

interface Sent {
  query: string;
  variables: { id?: number; ids?: number[]; q?: string };
}

/** NerdGraph fetch fake: records every body and answers both the single and the cross-account shape. */
function nerdgraph(answer: (sent: Sent) => unknown[] = () => []) {
  const sent: Sent[] = [];
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent;
    sent.push(body);
    const page = { issues: { issues: answer(body), nextCursor: null } };
    const scope = body.query.includes("aiIssues") ? { aiIssues: page } : { nrql: { results: answer(body) } };
    return new Response(JSON.stringify({ data: { actor: { account: scope, ...scope } } }));
  }) as unknown as typeof fetch;
  return { sent, fetch: fetchFake };
}

async function poll(kind: string, root: string, with_: Record<string, unknown>, answer?: (sent: Sent) => unknown[]) {
  const { sent, fetch } = nerdgraph(answer);
  const lines: string[] = [];
  const result = createPollHandler(source(kind), {
    env: { NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: "9" },
    fetch,
    stderr: { write: (line: string) => lines.push(line) },
  })(pollRequest(with_, { kept: true }, { kind, workspace: { id: "ws", root_dir: root } }));
  return { result, sent, lines };
}

async function callTool(name: string, input: Record<string, unknown>, root?: string) {
  const { sent, fetch } = nerdgraph();
  const handler = toolHandler(TOOLS.find(tool => tool.name === name)!, { env: { NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: "9" }, fetch });
  const scope = root ? { trustedWorkspace: { id: "ws", root } } : {};
  const error = await Promise.resolve(handler({ input, ...scope } as never)).then(
    () => undefined,
    (failure: unknown) => failure
  );
  return { sent, error };
}

const LIB_TOML = [
  "accounts = [2656688, 317703]",
  `logs_where = "global_event_name = 'MIGRATION' AND level = 'ERROR'"`,
  "logs_facet = 'service_name, step'",
  "",
].join("\n");
const LIB_SOURCE = { where: "{{logs_where}}", facet: "{{logs_facet}}", window: "24h", threshold: 3, notify_existing: true };

describe("D-24 project placeholders and cross-account queries", () => {
  test("UT-200 placeholders: where and facet expand from any string key, literally and in one pass", async () => {
    const root = workspace(`account_id = 5\nlogs_where = "level = 'ERROR' AND x = '$&'"\nlogs_facet = "service_name, step"\n`);
    const { result, sent } = await poll("logs", root, { where: "{{logs_where}}", facet: "{{logs_facet}}", threshold: 1 });
    await result;
    assert.equal(sent[0]?.query, NRQL_QUERY);
    assert.deepEqual(sent[0]?.variables, {
      id: 5,
      q: "SELECT count(*) FROM Log WHERE level = 'ERROR' AND x = '$&' FACET service_name, step SINCE 15 minutes ago LIMIT 501",
    });
    const tool = await callTool("recent_logs", { where: "{{logs_where}} AND app = '{{app}}'", app: "a" }, root);
    assert.equal(tool.error, undefined);
    assert.match(tool.sent[0]?.variables.q ?? "", /WHERE level = 'ERROR' AND x = '\$&' AND app = 'a' SINCE/);
  });

  test("UT-201 placeholders: a key the workspace does not set yields no items, keeps state, sends nothing; tools fail", async () => {
    for (const with_ of [LIB_SOURCE, { ...LIB_SOURCE, where: "level = 'ERROR'" }, { ...LIB_SOURCE, where: "{{ logs_where }}" }]) {
      const { result, sent, lines } = await poll("logs", workspace('app = "acme"\naccount_id = 1\n'), with_);
      assert.deepEqual(await result, { items: [], state: { kept: true }, more: false });
      assert.equal(sent.length, 0);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /^newrelic\/logs skipped: with\.(where|facet) uses \{\{.+\}\}; set .+ in \.compozy\/newrelic\.toml\n$/);
    }
    const errors = await poll("errors", workspace(), { account_id: 1, where: "appName = '{{app}}'" });
    assert.equal((await errors.result).items.length, 0);
    assert.deepEqual(errors.lines, ["newrelic/errors skipped: with.where uses {{app}}; set app in .compozy/newrelic.toml or with.app\n"]);
    const tool = await callTool("recent_logs", { account_id: 1, where: "{{logs_where}}" }, workspace());
    const decoded = decodeToolError(tool.error);
    assert.equal(decoded.toolCode, "tool_invalid_input");
    assert.equal(decoded.message, "where uses {{logs_where}}; set logs_where in .compozy/newrelic.toml");
    assert.equal(tool.sent.length, 0);
  });

  test("UT-202 project file: accounts list and string keys; unsafe values and bad lists are refused naming the path", async () => {
    const cases: Array<[string, RegExp]> = [
      ['logs_where = "a = 1; DROP"\n', /logs_where must not contain ;, \{\{ or \}\}/],
      ['logs_where = "{{app}}"\n', /logs_where must not contain/],
      ["accounts = []\n", /accounts must be a list of 1 to 20 positive integers/],
      ["accounts = [0]\n", /accounts must be a list of 1 to 20 positive integers/],
      [`accounts = [${Array.from({ length: 21 }, (_, i) => i + 1).join(", ")}]\n`, /accounts must be a list/],
      ['accounts = "1"\n', /accounts must be a list/],
      ["accounts = [1, 2,]\n", /line 1: expected/],
      ["app = [1]\n", /app must be a string/],
      ["accounts = [1]\naccounts = [2]\n", /line 2: duplicate key accounts/],
    ];
    for (const [toml, reason] of cases) {
      const { result, sent } = await poll("logs", workspace(toml), { account_id: 1, where: "x = 1", threshold: 1 });
      const error = await rejection(result);
      assert.equal(error.data?.code, "source_params_invalid", toml);
      assert.ok(error.message.startsWith(".compozy/newrelic.toml: "), error.message);
      assert.match(error.message, reason, toml);
      assert.equal(sent.length, 0);
    }
  });

  test("UT-203 accounts: explicit account_id → account_ids → file accounts → file account_id → env; cross-account query", async () => {
    const both = workspace("account_id = 7\naccounts = [317703, 2656688, 317703]\n");
    const target = async (with_: Record<string, unknown>, root: string) => {
      const { result, sent } = await poll("nrql", root, { nrql: "SELECT count(*) FROM Log", threshold: 1, ...with_ });
      await result;
      return sent[0]!;
    };
    assert.deepEqual((await target({ account_id: 3, account_ids: [4, 5] }, both)).variables.id, 3);
    const explicit = await target({ account_ids: [5, 4, 5] }, both);
    assert.equal(explicit.query, NRQL_CROSS_QUERY);
    assert.deepEqual(explicit.variables.ids, [4, 5]);
    assert.deepEqual((await target({}, both)).variables.ids, [317703, 2656688]);
    assert.deepEqual((await target({}, workspace("accounts = [8]\n"))).variables, { id: 8, q: "SELECT count(*) FROM Log" });
    assert.equal((await target({}, workspace("account_id = 7\n"))).variables.id, 7);
    assert.equal((await target({}, workspace())).variables.id, 9);

    const tool = async (name: string, input: Record<string, unknown>) => (await callTool(name, input, both)).sent[0]!.variables;
    assert.deepEqual((await tool("nrql_query", { nrql: "SELECT 1" })).ids, [317703, 2656688]);
    assert.deepEqual((await tool("nrql_query", { nrql: "SELECT 1", account_ids: [2] })).id, 2);
    assert.deepEqual((await tool("nrql_query", { nrql: "SELECT 1", account_id: 1, account_ids: [2, 3] })).id, 1);
    assert.deepEqual((await tool("recent_logs", { where: "x = 1" })).ids, [317703, 2656688]);
    assert.equal((await tool("error_groups", {})).id, 7, "single-account tools skip accounts");
    const bad = await callTool("nrql_query", { nrql: "SELECT 1", account_ids: [] }, both);
    assert.equal(decodeToolError(bad.error).message, "account_ids must be a list of 1 to 20 account ids (positive integers)");
  });

  test("UT-204 cross-account keys: logs, errors and issues are keyed per account; nrql runs as written", async () => {
    const root = workspace(LIB_TOML);
    const logs = await poll("logs", root, LIB_SOURCE, () => [
      { facet: ["317703", "svc-a", "migrate"], count: 5 },
      { facet: [2656688, "svc-a", "migrate"], count: 4 },
      { facet: ["317703", "svc-b", "seed"], count: 1 },
    ]);
    const logsResult = await logs.result;
    assert.equal(
      logs.sent[0]?.variables.q,
      "SELECT count(*) FROM Log WHERE global_event_name = 'MIGRATION' AND level = 'ERROR' " +
        "FACET accountId(), service_name, step SINCE 1440 minutes ago LIMIT 501"
    );
    assert.deepEqual(logsResult.items.map(item => item.key), ["317703/svc-a/migrate", "2656688/svc-a/migrate"]);
    const attributes = logsResult.items.map(item => item.attributes as Record<string, unknown>);
    assert.deepEqual(attributes.map(entry => [entry.account_id, entry.group]), [[317703, "svc-a/migrate"], [2656688, "svc-a/migrate"]]);
    assert.match(logsResult.items[1]!.summary!, /account 2656688 \(us\)/);

    const unfaceted = await poll("logs", root, { where: "{{logs_where}}", threshold: 0, notify_existing: true }, () => [
      { facet: "317703", count: 2 },
    ]);
    assert.match(unfaceted.sent[0]?.variables.q ?? "", / FACET accountId\(\) SINCE /);
    assert.deepEqual((await unfaceted.result).items.map(item => item.key), ["317703/all"]);

    const errors = await poll("errors", root, { notify_existing: true }, () => [
      { facet: ["317703", "svc", "Err", "boom 1"], count: 2 },
      { facet: ["2656688", "svc", "Err", "boom 2"], count: 2 },
    ]);
    const errorItems = (await errors.result).items;
    assert.match(errors.sent[0]?.variables.q ?? "", /FACET accountId\(\), appName, error\.class, error\.message/);
    assert.deepEqual(errorItems.map(item => item.key.split("/").slice(0, 3).join("/")).sort(), ["2656688/svc/Err", "317703/svc/Err"]);

    const issues = await poll("issues", root, { notify_existing: true }, sent => [
      { issueId: `i-${sent.variables.id}`, priority: "CRITICAL", state: "ACTIVATED", activatedAt: 1 },
    ]);
    const issueItems = (await issues.result).items;
    assert.deepEqual(issues.sent.map(entry => entry.variables.id), [317703, 2656688]);
    assert.deepEqual(issueItems.map(item => item.key).sort(), ["2656688/i-2656688", "317703/i-317703"]);
    assert.ok(issueItems.every(item => item.url?.includes(`/accounts/${item.key.split("/")[0]}/issues/`)));

    const nrql = await poll("nrql", root, { nrql: "SELECT count(*) FROM Log FACET accountId()", threshold: 0, notify_existing: true }, () => [
      { facet: "317703", count: 1 },
    ]);
    const nrqlItem = (await nrql.result).items[0]!;
    assert.equal(nrql.sent[0]?.variables.q, "SELECT count(*) FROM Log FACET accountId()");
    assert.equal(nrqlItem.key, "317703");
    assert.deepEqual((nrqlItem.attributes as Record<string, unknown>).account_ids, [317703, 2656688]);
  });

  test("UT-205 backward compatibility: app + account_id gives the v0.5.0 requests, items and state byte for byte", async () => {
    // Golden values recorded by running this exact scenario against v0.5.0 (5ebfeaa).
    const root = workspace('app = "acme-api"\naccount_id = 1234567\n');
    const requests: Sent[] = [];
    const withs: Record<string, Record<string, unknown>> = {
      errors: { where: "appName = '{{app}}'", notify_existing: true },
      logs: { where: "appName = '{{app}}' AND level = 'ERROR'", facet: "service_name, step", window: "24h", threshold: 3, notify_existing: true },
      issues: { notify_existing: true },
      nrql: { nrql: "SELECT count(*) FROM Log FACET service_name, step", threshold: 1, notify_existing: true },
    };
    const results: unknown[] = [];
    for (const definition of SOURCES) {
      const { result, sent } = await poll(definition.kind, root, withs[definition.kind]!, body =>
        body.query.includes("aiIssues")
          ? [{ issueId: "i-1", priority: "CRITICAL", state: "ACTIVATED", title: ["t"], entityNames: ["acme-api"], activatedAt: 1794790000000 }]
          : body.variables.q!.includes("FROM Log")
            ? [{ facet: ["svc-a", "migrate"], count: 5 }, { facet: ["svc-b", "seed"], count: 2 }]
            : [{ facet: ["acme-api", "Err", "boom 123"], count: 4 }]
      );
      const value = await result;
      requests.push(...sent);
      results.push({ ...value, state: value.state });
    }
    assert.deepEqual(
      requests.map(request => request.variables.q ?? request.variables.id),
      [
        "SELECT count(*) FROM Log FACET service_name, step",
        1234567,
        "SELECT count(*) FROM TransactionError WHERE appName = 'acme-api' FACET appName, error.class, error.message SINCE 30 minutes ago LIMIT 501",
        "SELECT count(*) FROM Log WHERE appName = 'acme-api' AND level = 'ERROR' FACET service_name, step SINCE 1440 minutes ago LIMIT 501",
      ]
    );
    assert.deepEqual(
      results.map(result => (result as { state: unknown }).state),
      [
        { v: 1, fp: "ae6c33795c57d34e", active: ["svc-a/migrate", "svc-b/seed"] },
        { v: 1, fp: "59c1515989e90c4e", active: ["i-1"] },
        { v: 1, fp: "73ad235fc12a1f00", active: ["acme-api/Err/1982f86e"] },
        { v: 1, fp: "d319297fe23642c7", active: ["svc-a/migrate"] },
      ]
    );
    const digest = createHash("sha256").update(JSON.stringify({ requests, results })).digest("hex");
    assert.equal(digest, "3a282483f6abf21a90e463905f0f1a92bbe21b25b876b94c459651499115c982");
  });
});
