# compozy-newrelic

CompozyOS extension `newrelic`: four check-in sources (`newrelic/nrql`, `newrelic/issues`,
`newrelic/errors`, `newrelic/logs`), NerdGraph-backed investigation tools, a `doctor` command, the
official New Relic MCP declared OAuth-only, and an API-key proxy to that MCP (`mcp_tools`,
`mcp_call`). The design contract lives in `.compozy/tasks/newrelic-sources/` (v0.1) and
`.compozy/tasks/newrelic-mcp-proxy/` (v0.2, which supersedes v0.1 where they differ) (`_spec.md`,
`_dx.md`, `_user_stories.md`, `_tests.md`, `_slices.md`, `adrs/`). Implement exactly that contract; record any deviation in the spec before
coding it. The sibling `../compozy-jira` is the reference implementation for structure, redaction,
error mapping and the loopback test approach.

## Stack

- TypeScript, ESM, Node.js >= 22 at runtime, `@compozy/extension-sdk` pinned to `0.7.0`.
- Build: `bun run build` (`tsc --noEmit` + `bun build src/index.ts --target=node --outfile=dist/index.js`),
  then `compozy extension build` produces the installable generation under `dist/gen-<hash>`.
- Tests: `bun test`, also runnable under Node 22. Fakes only at the network boundary (in-process
  `node:http` NerdGraph and MCP fakes); inject `fetch` and the clock. No real New Relic calls in
  automated tests.
- Runtime dependencies: only `@compozy/extension-sdk`; Node built-ins otherwise.

## Rules

- Only `src/index.ts` imports the SDK `Extension` and reads environment variables; only
  `src/nerdgraph.ts`, `src/mcp-client.ts` and `src/doctor.ts` do network I/O.
- `src/sources/**` and `src/engine.ts` never import `mcp-client` or `mcp-catalog` (UT-123).
- Never log, return, or persist `NEW_RELIC_API_KEY`; redact remote text before shortening it, and
  never follow redirects with the key (`redirect: "manual"`). Never send NerdGraph mutations. Only the proxy
  (`src/tools/mcp-proxy.ts`) calls MCP tools, and only exposed read-only ones.
- Items and tool results stay compact and bounded; never include raw log lines or stack traces.
- Keep source files cohesive and small (< 300 lines); extract before growing.
- Test IDs from `_tests.md` appear in test names (e.g. `UT-010 engine: ...`).
- Before committing: `bun run typecheck && bun test` pass with zero errors.
- Commits: `<type>: <description>` with `feat|fix|refactor|perf|docs|test|build|ci`, no scopes.
  Commits and tags are signed with the repository-local identity already configured; never change
  `user.*`, `user.signingkey`, or signing settings.
- Docs, code, commits and specs in English.
