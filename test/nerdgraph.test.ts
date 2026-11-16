import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { issueUrl, regionEndpoints } from "../src/nerdgraph.ts";
import { createPollHandler } from "../src/poll.ts";
import { nrqlSource } from "../src/sources/nrql.ts";
import { ACCOUNT, pollRequest, rejection } from "./helpers.ts";

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
