import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { HeartbeatSourceResult } from "@compozy/extension-sdk";

import { redactor } from "../src/items.ts";
import { type NerdGraphClient, regionEndpoints } from "../src/nerdgraph.ts";
import { epochMs, issuesQuery, issuesSource, parseIssuesParams } from "../src/sources/issues.ts";
import { ACCOUNT, assertRowOrderInvariant, catchSync, FAKE_KEY, pollRequest, rejection } from "./helpers.ts";

const BASE = { account_id: ACCOUNT };
const T0 = 1_794_000_000_000; // 2026-11-07T…Z

const issue = (id: string, priority: string, activatedAt: number | string, extra: Record<string, unknown> = {}) => ({
  issueId: id,
  title: [`${priority} trouble on ${id}`],
  priority,
  state: "ACTIVATED",
  entityNames: ["checkout-api"],
  activatedAt,
  createdAt: activatedAt,
  ...extra,
});

/** Answers every aiIssues query with one page of `issues()`. */
function issuesClient(issues: () => Record<string, unknown>[]): NerdGraphClient & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query<T>(gql: string) {
      queries.push(gql);
      return { actor: { account: { aiIssues: { issues: { issues: structuredClone(issues()), nextCursor: null } } } } } as T;
    },
    async nrql() {
      throw new Error("nrql not expected");
    },
  };
}

async function poll(
  issues: Record<string, unknown>[],
  state: unknown = { v: 1, fp: parseIssuesParams(BASE).fingerprint, active: [] },
  raw: Record<string, unknown> = BASE,
  client = issuesClient(() => issues)
): Promise<HeartbeatSourceResult> {
  const params = parseIssuesParams(raw);
  return await issuesSource.poll(pollRequest(raw, state), params, {
    client,
    endpoints: regionEndpoints(params.region),
    redact: redactor(FAKE_KEY),
    signal: new AbortController().signal,
  });
}

const keysOf = (result: HeartbeatSourceResult) => result.items.map(item => item.key);

describe("newrelic/issues", () => {
  test("UT-040 issues: a LOW issue gives no signal; a CRITICAL issue gives one keyed by issueId", async () => {
    const result = await poll([issue("low-1", "LOW", T0), issue("crit-1", "CRITICAL", T0)]);
    assert.deepEqual(keysOf(result), ["crit-1"]);
    assert.deepEqual(result.items[0], {
      key: "crit-1",
      title: "CRITICAL issue: CRITICAL trouble on crit-1",
      summary: `New Relic alert issue · account ${ACCOUNT} (us) · priority CRITICAL · state ACTIVATED · entities: checkout-api · activated ${new Date(T0).toISOString()}`,
      url: `https://radar-api.service.newrelic.com/accounts/${ACCOUNT}/issues/crit-1`,
      attributes: {
        kind: "issues",
        account_id: ACCOUNT,
        region: "us",
        issue_id: "crit-1",
        priority: "CRITICAL",
        state: "ACTIVATED",
        entities: "checkout-api",
        activated_at: new Date(T0).toISOString(),
        title: "CRITICAL trouble on crit-1",
      },
    });
    // Closed or deactivated issues are inactive even if a server ignored the states filter.
    const closed = await poll([issue("crit-2", "CRITICAL", T0, { state: "CLOSED" })]);
    assert.deepEqual(closed.items, []);
  });

  test("UT-041 issues: CRITICAL ranks before HIGH, then older activation first", async () => {
    const result = await poll([
      issue("high-old", "HIGH", T0 - 60_000),
      issue("crit-new", "CRITICAL", String(T0)), // EpochMilliseconds may arrive as a string
      issue("crit-old", "CRITICAL", T0 - 3_600_000),
      issue("high-new", "HIGH", T0),
    ]);
    assert.deepEqual(keysOf(result), ["crit-old", "crit-new", "high-old", "high-new"]);
    assert.equal(epochMs("1794000000000"), 1794000000000);
    assert.equal(epochMs("soon"), null);
  });

  test("UT-042 issues: a closed issue drops from state; the same id open again is returned", async () => {
    const opened = await poll([issue("crit-1", "CRITICAL", T0)]);
    assert.deepEqual(keysOf(opened), ["crit-1"]);
    const stays = await poll([issue("crit-1", "CRITICAL", T0)], opened.state);
    assert.deepEqual(stays.items, []);
    const closed = await poll([], stays.state);
    assert.deepEqual((closed.state as { active: string[] }).active, []);
    const reopened = await poll([issue("crit-1", "CRITICAL", T0 + 1)], closed.state);
    assert.deepEqual(keysOf(reopened), ["crit-1"]);
  });

  test("UT-042 issues: more open issues than fit max_state_bytes fail with source_params_invalid", async () => {
    const many = Array.from({ length: 600 }, (_, i) => issue(`issue-${String(i).padStart(4, "0")}-${"x".repeat(20)}`, "HIGH", T0));
    const error = await rejection(poll(many));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, "600 active signals do not fit max_state_bytes=16384; narrow the source");
  });

  test("UT-043 issues: priorities and entity_guids are passed into the aiIssues filter", async () => {
    const raw = { ...BASE, priorities: ["HIGH", "CRITICAL", "HIGH"], entity_guids: ["MXxBUE18QVBQTElDQVRJT058MQ==", "abc-1"] };
    const client = issuesClient(() => []);
    await poll([], null, raw, client);
    assert.equal(
      client.queries[0],
      'query($id:Int!){actor{account(id:$id){aiIssues{issues(filter:{states:[ACTIVATED,CREATED],priority:["CRITICAL","HIGH"],entityGuids:["MXxBUE18QVBQTElDQVRJT058MQ==","abc-1"]}){issues{issueId title priority state entityNames activatedAt createdAt} nextCursor}}}}}'
    );
    // No entity filter by default; a cursor is a JSON-encoded string literal.
    assert.ok(!issuesQuery(parseIssuesParams(BASE), 'a"b').includes("entityGuids"));
    assert.ok(issuesQuery(parseIssuesParams(BASE), 'a"b').includes(',cursor:"a\\"b"'));
    // Spelling and order of the lists do not change the fingerprint; their content does.
    assert.equal(parseIssuesParams(raw).fingerprint, parseIssuesParams({ ...raw, priorities: ["CRITICAL", "HIGH"] }).fingerprint);
    assert.equal(parseIssuesParams(BASE).fingerprint, parseIssuesParams({ ...BASE, priorities: ["HIGH", "CRITICAL"] }).fingerprint);
    assert.notEqual(parseIssuesParams(BASE).fingerprint, parseIssuesParams(raw).fingerprint);
    // policy_ids is not supported (Deviation D-S2-a); invalid guids and priorities are rejected.
    assert.equal(catchSync(() => parseIssuesParams({ ...BASE, entity_guids: ['x"}'] })).data?.code, "source_params_invalid");
    assert.equal(catchSync(() => parseIssuesParams({ ...BASE, priorities: ["URGENT"] })).data?.code, "source_params_invalid");
    assert.equal(catchSync(() => parseIssuesParams({ ...BASE, priorities: [] })).data?.code, "source_params_invalid");
  });

  test("UT-071 issues: an API key inside issue titles or entity names never appears in the item", async () => {
    const result = await poll([issue("crit-1", "CRITICAL", T0, { title: [`leak ${FAKE_KEY}`], entityNames: [FAKE_KEY] })]);
    const text = JSON.stringify(result);
    assert.equal(text.includes(FAKE_KEY), false);
    assert.ok(text.includes("[redacted]"));
  });

  test("UT-121 determinism: shuffled aiIssues order gives an identical issues result", async () => {
    const rows = [
      issue("high-old", "HIGH", T0 - 60_000),
      issue("crit-new", "CRITICAL", T0),
      issue("crit-old", "CRITICAL", T0 - 3_600_000),
      issue("crit-old", "CRITICAL", T0 - 3_600_000, { title: ["duplicate page entry"] }),
      issue("low-1", "LOW", T0),
    ];
    const result = await assertRowOrderInvariant(rows, ordered => poll(ordered));
    assert.deepEqual(keysOf(result), ["crit-old", "crit-new", "high-old"]);
  });
});
