import { nrqlSource } from "./nrql.ts";
import type { SourceDefinition } from "./source.ts";

/** Every registered check-in source kind; add new kinds here (one line each). */
export const SOURCES: SourceDefinition[] = [nrqlSource];
