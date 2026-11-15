# Slices: New Relic check-in sources and investigation tools

| Slice | Layer | Depends on | Scope | Spec refs |
| ----- | ----- | ---------- | ----- | --------- |
| S1 | extension | none | Project skeleton (TS, SDK 0.7.0, build), NerdGraph client + region + credential errors, transition engine, normalize/keys, `newrelic/nrql` source end to end, loopback test hook, local install + dry run | US-001, US-005, US-006, US-007; ADR-001; UT-010–UT-019, UT-030–UT-033, UT-070, UT-071, UT-080, UT-081, UT-120–UT-123, IT-001, IT-004–IT-011, E2E-001 |
| S2 | extension | S1 | `newrelic/issues` (with NerdGraph introspection of aiIssues), `newrelic/errors`, `newrelic/logs` | US-002, US-003, US-004; UT-040–UT-062, UT-121 (issues/errors/logs), IT-002, IT-003 |
| S3 | extension | S1 | Six investigation tools + `doctor` (tool, command block, startup probe line) | US-008, US-010; ADR-002; UT-090–UT-102, IT-012, IT-013 |
| S4 | extension | S1 | OAuth MCP servers `newrelic` / `newrelic-eu` in the SDK definition; verify the New Relic OAuth client contract against CompozyOS OAuth; record outcome as deviation if unusable | US-009; ADR-002; UT-110 |
| S5 | docs/ci | S2, S3, S4 | README (golden path, NRQL gallery, plan matrix, replacing a manual `newrelicapi` MCP, "Cost model" section per Business Rule 12), LICENSE, CI (bun + Node 22) | US-007, US-009, US-010, US-011 |
| S6 | release | S5 | Public repo `jillesmc/compozy-newrelic` (topic `compozy-extension`), signed tag v0.1.0, publish, E2E-005 | US-011 |
| S7 | outreach | S6 | Draft the curated-catalog PR content (category `development`) into `s7-catalog-pr.md`; not opened without approval | — |

S1 delivers the earliest useful outcome: an always-on agent woken when a New Relic metric starts
breaching. S2, S3 and S4 can run in parallel after S1.
