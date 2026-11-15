# compozy-newrelic

CompozyOS extension `newrelic`: four check-in sources (`newrelic/nrql`, `newrelic/issues`,
`newrelic/errors`, `newrelic/logs`), NerdGraph-backed investigation tools, a `doctor` command, and the
official New Relic MCP declared OAuth-only. The design contract lives in
`.compozy/tasks/newrelic-sources/` (`_spec.md`, `_dx.md`, `_user_stories.md`, `_tests.md`,
`_slices.md`, `adrs/`). Implement exactly that contract; record any deviation in the spec before
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
  `src/nerdgraph.ts` and `src/doctor.ts` do network I/O.
- Never log, return, or persist `NEW_RELIC_API_KEY`. Never send NerdGraph mutations; never call MCP tools.
- Items and tool results stay compact and bounded; never include raw log lines or stack traces.
- Keep source files cohesive and small (< 300 lines); extract before growing.
- Test IDs from `_tests.md` appear in test names (e.g. `UT-010 engine: ...`).
- Before committing: `bun run typecheck && bun test` pass with zero errors.
- Commits: `<type>: <description>` with `feat|fix|refactor|perf|docs|test|build|ci`, no scopes.
  Commits and tags are signed with the repository-local identity already configured; never change
  `user.*`, `user.signingkey`, or signing settings.
- Docs, code, commits and specs in English.
