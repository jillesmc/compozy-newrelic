# Slices: New Relic official MCP proxy (v0.2.0)

| Slice | Layer | Depends on | Scope | Spec refs |
| ----- | ----- | ---------- | ----- | --------- |
| S1 | extension | none | `mcp-client.ts` (Streamable HTTP, JSON+SSE, session), `mcp-catalog.ts` (filter, TTL, OAuth-only set), `mcp_tools` + `mcp_call`, doctor counts, fake MCP, UT-123 extension | US-101–US-105; ADR-001; UT-130–UT-171, UT-190, IT-101–IT-107, E2E-101, E2E-102 |
| S2 | docs | S1 | README: proxy usage, migration from `newrelicapi`, plan matrix update, cost model note (proxy tools cost tokens only after wake) | US-106 |
| S3 | extension | S1 | Follow-ups: install scope investigation/fix (US-107), nested NRQL cells (US-108); version 0.2.0 | US-107, US-108; UT-180 |
| S4 | release | S2, S3 | Signed tag v0.2.0, publish `dist/release`, E2E-104 | US-107 |

S1 is the earliest useful outcome: agents reach every working official MCP tool with the API key.
