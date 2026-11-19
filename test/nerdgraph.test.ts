import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { issueUrl, regionEndpoints } from "../src/nerdgraph.ts";
import { createPollHandler } from "../src/poll.ts";
import { errorsSource } from "../src/sources/errors.ts";
import { nrqlSource } from "../src/sources/nrql.ts";
import { ACCOUNT, FAKE_KEY, pollRequest, rejection } from "./helpers.ts";

const params = { account_id: ACCOUNT, nrql: "SELECT count(*) FROM Transaction", threshold: 1 };

describe("credentials and region", () => {
  test("UT-080 credentials: no key is credential_absent, a non-NRAK key is credential_expired, no network call", async () => {
    let calls = 0;
    const fetchSpy = (async () => {
      calls++;
      throw new Error("no network expected");
    }) as typeof fetch;
    const lines: string[] = [];
    const stderr = { write: (line: string) => lines.push(line) };
    const poll = (env: Record<string, string>) =>
      createPollHandler(nrqlSource, { env, fetch: fetchSpy, stderr })(pollRequest(params));

    const absent = await rejection(poll({}));
    assert.equal(absent.data?.code, "source_credential_absent");
    assert.equal(
      absent.message,
      "New Relic API key missing; run compozy extension secrets set newrelic --env NEW_RELIC_API_KEY"
    );
    const blank = await rejection(poll({ NEW_RELIC_API_KEY: "  " }));
    assert.equal(blank.data?.code, "source_credential_absent");

    const licenseKey = "eu01xxLICENSEKEYVALUE0000000000NRAL";
    const expired = await rejection(poll({ NEW_RELIC_API_KEY: licenseKey }));
    assert.equal(expired.data?.code, "source_credential_expired");
    assert.equal(expired.message, "New Relic rejected the API key; bind a User API key (NRAK-...)");
    assert.equal(calls, 0);
    assert.deepEqual(lines, [
      "newrelic/nrql poll failed: code=source_credential_absent status=-\n",
      "newrelic/nrql poll failed: code=source_credential_absent status=-\n",
      "newrelic/nrql poll failed: code=source_credential_expired status=-\n",
    ]);
    assert.equal(lines.join("").includes(licenseKey), false);
  });

  test("UT-081 region: us, eu and loopback resolve NerdGraph and MCP probe URLs", () => {
    assert.deepEqual(regionEndpoints("us"), {
      graphql: "https://api.newrelic.com/graphql",
      mcp: "https://mcp.newrelic.com/mcp/",
      web: "https://one.newrelic.com",
      issues: "https://radar-api.service.newrelic.com",
    });
    assert.deepEqual(regionEndpoints("eu"), {
      graphql: "https://api.eu.newrelic.com/graphql",
      mcp: "https://mcp.eu.newrelic.com/mcp/",
      web: "https://one.eu.newrelic.com",
      issues: "https://radar-api.service.eu.newrelic.com",
    });
    assert.deepEqual(regionEndpoints("loopback:8788"), {
      graphql: "http://127.0.0.1:8788/graphql",
      mcp: "http://127.0.0.1:8788/mcp/",
    });
  });

  test("UT-082 issue links: New Relic's issue redirect per region; none for loopback", () => {
    assert.equal(
      issueUrl(regionEndpoints("us"), 317703, "2a9c de"),
      "https://radar-api.service.newrelic.com/accounts/317703/issues/2a9c%20de"
    );
    assert.equal(issueUrl(regionEndpoints("eu"), 1, "x"), "https://radar-api.service.eu.newrelic.com/accounts/1/issues/x");
    assert.equal(issueUrl(regionEndpoints("loopback:8788"), 1, "x"), undefined);
    assert.equal(issueUrl(regionEndpoints("us"), 1, ""), undefined);
  });
});

describe("factory-user-agents workspace defaults (NEW_RELIC_ACCOUNT_ID)", () => {
  /** Polls newrelic/errors through the handler with a NerdGraph fetch spy that answers no rows. */
  async function pollErrors(with_: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
    const sent: { id: number; q: string }[] = [];
    const fetchSpy = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).variables);
      return new Response(JSON.stringify({ data: { actor: { account: { nrql: { results: [] } } } } }));
    }) as unknown as typeof fetch;
    const env = { NEW_RELIC_API_KEY: FAKE_KEY, ...extraEnv };
    const run = createPollHandler(errorsSource, { env, fetch: fetchSpy, stderr: { write: () => true } })(
      pollRequest(with_, null, { kind: "errors" })
    );
    return { run, sent };
  }

  test("UT-040 workspace defaults: no with.account_id uses NEW_RELIC_ACCOUNT_ID", async () => {
    const { run, sent } = await pollErrors({}, { NEW_RELIC_ACCOUNT_ID: "317703" });
    await run;
    assert.equal(sent[0]?.id, 317703);
  });

  test("UT-041 workspace defaults: an explicit with.account_id wins over NEW_RELIC_ACCOUNT_ID", async () => {
    const { run, sent } = await pollErrors({ account_id: ACCOUNT }, { NEW_RELIC_ACCOUNT_ID: "317703" });
    await run;
    assert.equal(sent[0]?.id, ACCOUNT);
  });

  test("UT-042 workspace defaults: neither is params_invalid naming both; a malformed default too", async () => {
    const { run, sent } = await pollErrors({});
    const neither = await rejection(run);
    assert.equal(neither.data?.code, "source_params_invalid");
    assert.equal(neither.message, "set with.account_id, account_id in .compozy/newrelic.toml, or NEW_RELIC_ACCOUNT_ID");
    const bad = await pollErrors({}, { NEW_RELIC_ACCOUNT_ID: "31x" });
    assert.equal((await rejection(bad.run)).data?.code, "source_params_invalid");
    assert.equal(sent.length + bad.sent.length, 0);
  });
});
