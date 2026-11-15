import { errorsSource } from "./errors.ts";
import { issuesSource } from "./issues.ts";
import { logsSource } from "./logs.ts";
import { nrqlSource } from "./nrql.ts";
import type { SourceDefinition } from "./source.ts";

/** Every registered check-in source kind; add new kinds here (one line each). */
export const SOURCES: SourceDefinition[] = [nrqlSource, issuesSource, errorsSource, logsSource];
