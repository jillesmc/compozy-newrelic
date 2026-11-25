import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createPollHandler } from "../src/poll.ts";
import { errorsSource } from "../src/sources/errors.ts";
import { toolHandler, TOOLS } from "../src/tools/index.ts";
import { decodeToolError, FAKE_KEY, pollRequest, rejection } from "./helpers.ts";

const roots: string[] = [];
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

/** A workspace root whose `.compozy/newrelic.toml` holds `toml` (no file when undefined). */
function workspace(toml?: string): string {
  const root = mkdtempSync(join(tmpdir(), "nr-project-"));
  roots.push(root);
  if (toml !== undefined) {
    mkdirSync(join(root, ".compozy"));
    writeFileSync(join(root, ".compozy", "newrelic.toml"), toml);
  }
  return root;
}

/** NerdGraph fetch spy answering no rows; records each NRQL `{id, q}`. */
function spy() {
  const sent: { id: number; q: string }[] = [];
  const fetchSpy = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).variables);
    return new Response(JSON.stringify({ data: { actor: { account: { nrql: { results: [] } } } } }));
  }) as unknown as typeof fetch;
  return { sent, fetch: fetchSpy };
}

/** Polls newrelic/errors in workspace `root` with `with_` and extra env. */
async function poll(root: string, with_: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const { sent, fetch } = spy();
  const lines: string[] = [];
  const env = { NEW_RELIC_API_KEY: FAKE_KEY, ...extraEnv };
  const run = createPollHandler(errorsSource, { env, fetch, stderr: { write: (line: string) => lines.push(line) } })(
    pollRequest(with_, null, { kind: "errors", workspace: { id: "ws_test", root_dir: root } })
  );
  return { run, sent, lines };
}

const WHERE = "appName = '{{app}}'";
const MAX_FILE = 4096;

describe("factory-roles per-project file (.compozy/newrelic.toml)", () => {
  test("UT-021 project file: a poll expands {{app}} from its own workspace's file", async () => {
    for (const app of ["acme-api", "widgets-web"]) {
      const { run, sent } = await poll(workspace(`app = "${app}"\naccount_id = 1234567\n`), { where: WHERE });
      await run;
      assert.match(sent[0]?.q ?? "", new RegExp(`WHERE appName = '${app}' `));
      assert.equal(sent[0]?.id, 1234567);
    }
  });

  test("UT-022 project file: {{app}} with no file and no with.app yields no items and no query (D-24); NEW_RELIC_APP is ignored", async () => {
    const { run, sent, lines } = await poll(workspace(), { account_id: 1, where: WHERE }, { NEW_RELIC_APP: "other" });
    assert.deepEqual(await run, { items: [], state: null, more: false });
    assert.deepEqual(lines, ["newrelic/errors skipped: with.where uses {{app}}; set app in .compozy/newrelic.toml or with.app\n"]);
    assert.equal(sent.length, 0);
  });

  test("UT-023 project file: an app with a quote or backslash (file or with.app) is source_params_invalid; no query", async () => {
    for (const bad of ["a' OR 1=1 --", 'a"b', "a\\b"]) {
      const literal = bad.includes("'") ? `"${bad}"` : `'${bad}'`;
      for (const [root, with_] of [
        [workspace(`app = ${literal}\n`), { account_id: 1, where: WHERE }],
        [workspace(), { account_id: 1, where: WHERE, app: bad }],
      ] as const) {
        const { run, sent } = await poll(root, with_);
        const error = await rejection(run);
        assert.equal(error.data?.code, "source_params_invalid", bad);
        assert.equal(error.message.includes(bad), false);
        assert.equal(sent.length, 0);
      }
    }
  });

  test("UT-034 project file: with.app beats the file; the file account beats NEW_RELIC_ACCOUNT_ID; no file → env", async () => {
    const env = { NEW_RELIC_ACCOUNT_ID: "1" };
    const file = workspace('app = "y"\naccount_id = 2 # project account\n');
    const explicit = await poll(file, { where: WHERE, app: "x" }, env);
    await explicit.run;
    assert.match(explicit.sent[0]?.q ?? "", /WHERE appName = 'x' /);
    assert.equal(explicit.sent[0]?.id, 2);
    const explicitAccount = await poll(file, { where: WHERE, account_id: 3 }, env);
    await explicitAccount.run;
    assert.equal(explicitAccount.sent[0]?.id, 3);
    const none = await poll(workspace(), {}, env);
    await none.run;
    assert.equal(none.sent[0]?.id, 1);
  });

  test("UT-035 project file: a tool reads the file under trustedWorkspace.root; without it, no file and explicit app", async () => {
    const tool = TOOLS.find(t => t.name === "error_groups")!;
    const root = workspace('app = "acme-api"\naccount_id = 2\n');
    const call = async (input: Record<string, unknown>, trustedWorkspace?: { id: string; root: string }) => {
      const { sent, fetch } = spy();
      const handler = toolHandler(tool, { env: { NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: "1" }, fetch });
      try {
        await handler({ input, ...(trustedWorkspace ? { trustedWorkspace } : {}) } as never);
        return { sent, error: undefined };
      } catch (error) {
        return { sent, error };
      }
    };
    const trusted = await call({ where: WHERE }, { id: "ws_a", root });
    assert.equal(trusted.error, undefined);
    assert.match(trusted.sent[0]?.q ?? "", /WHERE appName = 'acme-api' /);
    assert.equal(trusted.sent[0]?.id, 2);

    const untrusted = await call({ where: WHERE });
    const decoded = decodeToolError(untrusted.error);
    assert.equal(decoded.toolCode, "tool_invalid_input");
    assert.equal(decoded.message, "where uses {{app}}; set app in .compozy/newrelic.toml or app");
    assert.equal(untrusted.sent.length, 0);

    const explicit = await call({ where: WHERE, app: "widgets" });
    assert.match(explicit.sent[0]?.q ?? "", /WHERE appName = 'widgets' /);
    assert.equal(explicit.sent[0]?.id, 1, "env account default only, no file");
  });

  test("UT-036 project file: a malformed file is source_params_invalid naming the path; no query", async () => {
    const cases: Array<[string, RegExp]> = [
      ["app = acme\n", /line 1: expected key = "string", key = integer or accounts = \[integers\]/],
      ['[newrelic]\napp = "acme"\n', /line 1: expected/],
      ['account_id = "123"\n', /account_id must be a positive integer/],
      ["account_id = 0\n", /account_id must be a positive integer/],
      ["app = 5\n", /app must be a string/],
      ['app = "a"\napp = "b"\n', /line 2: duplicate key app/],
      ["app_name = 5\n", /line 1: app_name must be a string \(only account_id and accounts take numbers\)/],
      ['app = ""\n', /app must be a non-empty string/],
    ];
    for (const [toml, reason] of cases) {
      const { run, sent } = await poll(workspace(toml), { account_id: 1, where: WHERE });
      const error = await rejection(run);
      assert.equal(error.data?.code, "source_params_invalid", toml);
      assert.ok(error.message.startsWith(".compozy/newrelic.toml: "), error.message);
      assert.match(error.message, reason);
      assert.equal(sent.length, 0);
    }
    const tool = TOOLS.find(t => t.name === "nrql_query")!;
    const root = workspace("account_id = x\n");
    const handler = toolHandler(tool, { env: { NEW_RELIC_API_KEY: FAKE_KEY } });
    const error = await Promise.resolve(handler({ input: { nrql: "SELECT 1" }, trustedWorkspace: { id: "ws_a", root } } as never)).catch(
      (failure: unknown) => failure
    );
    const decoded = decodeToolError(error);
    assert.equal(decoded.toolCode, "tool_invalid_input");
    assert.match(decoded.message, /^\.compozy\/newrelic\.toml: line 1/);
  });
});

/** Calls tool `name` with `input`, under trusted workspace `root` when given; never throws. */
async function callTool(name: string, input: Record<string, unknown>, root?: string) {
  const { sent, fetch } = spy();
  const handler = toolHandler(TOOLS.find(t => t.name === name)!, { env: { NEW_RELIC_API_KEY: FAKE_KEY }, fetch });
  const scope = root ? { trustedWorkspace: { id: "ws_a", root } } : {};
  const error = await Promise.resolve(handler({ input, ...scope } as never)).then(
    () => undefined,
    (failure: unknown) => failure
  );
  return { sent, error };
}

describe("factory-roles per-project file: review repairs", () => {
  const DIRECTIVES = ["acme-$&", "a$$b", "$` OR 1=1 OR $`", "$1", "x$<y>"];

  test("UT-023 project file (review N-1): $ replacement directives in app are inserted literally by the poll handler", async () => {
    const reference = await poll(workspace(), { account_id: 1, where: WHERE, app: "PLACEHOLDER" });
    await reference.run;
    const template = reference.sent[0]!.q;
    for (const app of DIRECTIVES) {
      for (const [root, with_] of [
        [workspace(`app = "${app}"\n`), { account_id: 1, where: WHERE }],
        [workspace(), { account_id: 1, where: WHERE, app }],
      ] as const) {
        const { run, sent } = await poll(root, with_);
        await run;
        assert.equal(sent[0]?.q, template.split("PLACEHOLDER").join(app), app);
        assert.ok(sent[0]?.q.includes(`WHERE appName = '${app}' `));
      }
    }
  });

  test("UT-023 project file (review N-1): $ replacement directives in app are inserted literally by the tool handler", async () => {
    const reference = await callTool("error_groups", { account_id: 1, where: WHERE, app: "PLACEHOLDER" });
    const template = reference.sent[0]!.q;
    for (const app of DIRECTIVES) {
      const fromFile = await callTool("error_groups", { where: WHERE }, workspace(`app = "${app}"\naccount_id = 1\n`));
      const explicit = await callTool("error_groups", { account_id: 1, where: WHERE, app });
      for (const { sent, error } of [fromFile, explicit]) {
        assert.equal(error, undefined);
        assert.equal(sent[0]?.q, template.split("PLACEHOLDER").join(app), app);
      }
    }
  });

  /** Fixtures the reader must refuse: links out of the workspace, a FIFO, an oversize file. */
  function refusedFixtures(): Array<[string, string, RegExp]> {
    const other = workspace('app = "other-app"\naccount_id = 9\n');
    const fileLink = workspace();
    mkdirSync(join(fileLink, ".compozy"));
    symlinkSync(join(other, ".compozy", "newrelic.toml"), join(fileLink, ".compozy", "newrelic.toml"));
    const dirLink = workspace();
    symlinkSync(join(other, ".compozy"), join(dirLink, ".compozy"));
    const fifo = workspace();
    mkdirSync(join(fifo, ".compozy"));
    execFileSync("mkfifo", [join(fifo, ".compozy", "newrelic.toml")]);
    const oversize = workspace(`app = "acme"\n${"#".repeat(MAX_FILE)}\n`);
    return [
      ["file symlink", fileLink, /the file must be a regular file, not a link/],
      [".compozy symlink", dirLink, /\.compozy must be a real directory, not a link/],
      ["FIFO", fifo, /the file must be a regular file$/],
      ["oversize", oversize, /larger than 4 KiB/],
    ];
  }

  test("UT-036 project file (review N-2): links, a FIFO and an oversize file are refused by the poll handler; no fetch", async () => {
    for (const [label, root, reason] of refusedFixtures()) {
      const { run, sent } = await poll(root, { where: WHERE });
      const error = await rejection(run);
      assert.equal(error.data?.code, "source_params_invalid", label);
      assert.ok(error.message.startsWith(".compozy/newrelic.toml: "), error.message);
      assert.match(error.message, reason, label);
      assert.equal(sent.length, 0, label);
    }
  });

  test("UT-036 project file (review N-2): links, a FIFO and an oversize file are refused by the tool handler; no fetch", async () => {
    for (const [label, root, reason] of refusedFixtures()) {
      const { sent, error } = await callTool("error_groups", { where: WHERE }, root);
      const decoded = decodeToolError(error);
      assert.equal(decoded.toolCode, "tool_invalid_input", label);
      assert.match(decoded.message, /^\.compozy\/newrelic\.toml: /);
      assert.match(decoded.message, reason, label);
      assert.equal(sent.length, 0, label);
    }
  });

  test("UT-023 project file (review N-3): app of 256 characters is accepted, 257 refused (file and with.app)", async () => {
    const ok = "a".repeat(256);
    const long = "a".repeat(257);
    for (const [root, with_] of [
      [workspace(`app = "${ok}"\n`), { account_id: 1, where: WHERE }],
      [workspace(), { account_id: 1, where: WHERE, app: ok }],
    ] as const) {
      const { run, sent } = await poll(root, with_);
      await run;
      assert.ok(sent[0]?.q.includes(`'${ok}'`));
    }
    for (const [root, with_] of [
      [workspace(`app = "${long}"\n`), { account_id: 1, where: WHERE }],
      [workspace(), { account_id: 1, where: WHERE, app: long }],
    ] as const) {
      const { run, sent } = await poll(root, with_);
      const error = await rejection(run);
      assert.match(error.message, /app must be a non-empty string of at most 256 characters$/);
      assert.equal(sent.length, 0);
    }
  });

  test("UT-036 project file (review N-3): a file of 4096 bytes is accepted, 4097 refused", async () => {
    const head = 'app = "acme"\naccount_id = 1\n#';
    const sized = (bytes: number) => `${head}${"x".repeat(bytes - head.length - 1)}\n`;
    assert.equal(Buffer.byteLength(sized(MAX_FILE)), MAX_FILE);
    const ok = await poll(workspace(sized(MAX_FILE)), { where: WHERE });
    await ok.run;
    assert.ok(ok.sent[0]?.q.includes("'acme'"));
    const over = await poll(workspace(sized(MAX_FILE + 1)), { where: WHERE });
    assert.match((await rejection(over.run)).message, /^\.compozy\/newrelic\.toml: the file is larger than 4 KiB \(4096 bytes\)$/);
    assert.equal(over.sent.length, 0);
  });
});
