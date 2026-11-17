import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createExtension } from "../src/index.ts";
import { normalizeMessage, sanitizeKey } from "../src/normalize.ts";

describe("entry point and normalize", () => {
  test("index: describe() carries min_compozy_version 0.7.0, the env keys and the four kinds", () => {
    const payload = createExtension().describe();
    assert.equal(payload.sdk.min_compozy_version, "0.7.0");
    assert.deepEqual([...(payload.requires_env ?? [])].sort(), ["NEW_RELIC_ACCOUNT_ID", "NEW_RELIC_API_KEY", "NEW_RELIC_APP"]);
    assert.deepEqual([...(payload.provides ?? [])].sort(), ["heartbeat.source", "tool.provider"]);
    assert.deepEqual([payload.subprocess?.command, payload.subprocess?.args], ["node", ["index.js"]]);
    const kinds = payload.heartbeat_source_kinds ?? [];
    assert.deepEqual(kinds.map(kind => [kind.kind, kind.title]), [
      ["errors", "New errors"],
      ["issues", "New Relic alert issues"],
      ["logs", "Log spikes"],
      ["nrql", "NRQL threshold"],
    ]);
    const schema = kinds.find(kind => kind.kind === "nrql")?.params_schema as { required: string[]; additionalProperties: boolean };
    assert.deepEqual(schema.required, ["nrql", "threshold"]);
    assert.equal(schema.additionalProperties, false);
  });

  test("normalize: keys keep valid input verbatim and map everything else onto the daemon alphabet", () => {
    assert.equal(sanitizeKey("checkout-api/prod"), "checkout-api/prod");
    assert.equal(sanitizeKey("checkout_api"), "checkout_api");
    assert.match(sanitizeKey("checkout api"), /^checkout-api#[0-9a-f]{8}$/);
    assert.notEqual(sanitizeKey("a b"), sanitizeKey("a-b"));
    assert.match(sanitizeKey(""), /^x#[0-9a-f]{8}$/);
    assert.match(sanitizeKey("a".repeat(250)), /^a{180}#[0-9a-f]{12}$/);
  });

  test("normalize: messages collapse ids, numbers and quoted values and stay within 160 characters", () => {
    assert.equal(normalizeMessage("Order 123 not found"), "Order # not found");
    assert.equal(
      normalizeMessage("User 'ana' failed for 3f2b1c4d-0000-4a4a-9b9b-1234567890ab at  deadbeef42"),
      "User # failed for # at #"
    );
    assert.equal(Array.from(normalizeMessage("é".repeat(400))).length, 160);
  });
});
