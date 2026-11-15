import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decodeState, encodeState, fingerprint, transition, type Signal } from "../src/engine.ts";
import { catchSync } from "./helpers.ts";

const FP = fingerprint({ kind: "nrql", nrql: "SELECT count(*) FROM Transaction" });
const LIMITS = { max_items: 20, max_state_bytes: 16384 };
const state = (active: string[], fp = FP) => ({ v: 1, fp, active });
const signal = (key: string, rank = 1): Signal => ({ key, rank, item: { key, title: `item ${key}` } });
const keysOf = (result: { items: Array<{ key: string }> }) => result.items.map(item => item.key);

function run(committed: unknown, signals: Signal[], options: Partial<Parameters<typeof transition>[0]> = {}) {
  return transition({ committed, fingerprint: FP, signals, notifyExisting: false, limits: LIMITS, ...options });
}

describe("engine", () => {
  test("UT-010 engine: a newly active key is returned and committed", () => {
    const result = run(state([]), [signal("a")]);
    assert.deepEqual(keysOf(result), ["a"]);
    assert.deepEqual(result.state, state(["a"]));
    assert.equal(result.more, false);
  });

  test("UT-011 engine: still-active key is not returned again", () => {
    const result = run(state(["a"]), [signal("a")]);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.state, state(["a"]));
  });

  test("UT-012 engine: a recovered key drops silently and is returned on re-breach", () => {
    const recovered = run(state(["a"]), []);
    assert.deepEqual(recovered.items, []);
    assert.deepEqual(recovered.state, state([]));
    const again = run(recovered.state, [signal("a")]);
    assert.deepEqual(keysOf(again), ["a"]);
  });

  test("UT-013 engine: faceted keys are independent", () => {
    const result = run(state(["x"]), [signal("x"), signal("y")]);
    assert.deepEqual(keysOf(result), ["y"]);
    assert.deepEqual(result.state, state(["x", "y"]));
  });

  test("UT-015 engine: the first poll is a quiet baseline that commits the active set", () => {
    const result = run(null, [signal("b"), signal("a")]);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.state, state(["a", "b"]));
  });

  test("UT-016 engine: notify_existing returns the baseline active set", () => {
    const result = run(null, [signal("a"), signal("b")], { notifyExisting: true });
    assert.deepEqual(keysOf(result).sort(), ["a", "b"]);
    assert.deepEqual(result.state, state(["a", "b"]));
  });

  test("UT-017 engine: a fingerprint mismatch re-baselines; notify_existing is not in the fingerprint", () => {
    const result = run(state(["a"], "0000000000000000"), [signal("a"), signal("b")]);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.state, state(["a", "b"]));
    assert.equal(decodeState({ v: 2, fp: FP, active: [] }), null);
    // Sources fingerprint every defining parameter except notify_existing (see UT-017 nrql).
    assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  });

  test("UT-018 engine: max_items pages by rank, unreturned keys stay out and come back next poll", () => {
    const signals = Array.from({ length: 25 }, (_, i) => signal(`k${String(i).padStart(2, "0")}`, i));
    const first = run(state([]), signals, { limits: { ...LIMITS, max_items: 20 } });
    assert.equal(first.items.length, 20);
    assert.equal(first.more, true);
    assert.deepEqual(keysOf(first), signals.slice(5).reverse().map(s => s.key));
    assert.equal((first.state as { active: string[] }).active.length, 20);
    const second = run(first.state, signals, { limits: { ...LIMITS, max_items: 20 } });
    assert.deepEqual(keysOf(second), ["k04", "k03", "k02", "k01", "k00"]);
    assert.equal(second.more, false);
  });

  test("UT-018 engine: rank ties break by key ascending", () => {
    const result = run(state([]), [signal("c"), signal("a"), signal("b")]);
    assert.deepEqual(keysOf(result), ["a", "b", "c"]);
  });

  test("UT-019 engine: an active set over max_state_bytes fails with count and limit, never truncates", () => {
    const signals = Array.from({ length: 200 }, (_, i) => signal(`checkout-api-instance-${i}`));
    const limits = { max_items: 20, max_state_bytes: 1024 };
    const error = catchSync(() => run(state([]), signals, { limits }));
    assert.equal(error.data?.code, "source_params_invalid");
    assert.equal(error.message, "200 active signals do not fit max_state_bytes=1024; narrow the source");
    // The whole active set counts, even when only max_items would be returned or nothing is new.
    const committed = encodeState(FP, signals.slice(0, 10).map(s => s.key));
    assert.throws(() => run(committed, signals, { limits }), /200 active signals/);
  });

  test("UT-122 engine: an unchanged active set gives zero items and a byte-identical state", () => {
    const committed = run(null, [signal("b"), signal("a"), signal("c")]).state;
    const committedJson = JSON.stringify(committed);
    const result = run(JSON.parse(committedJson), [signal("c", 9), signal("a", 3), signal("b")]);
    assert.deepEqual(result.items, []);
    assert.equal(JSON.stringify(result.state), committedJson);
  });
});
