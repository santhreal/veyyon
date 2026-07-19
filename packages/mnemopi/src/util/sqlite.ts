// tableExists is a generic sqlite helper with one home in the shared lib. It is
// re-exported here so mnemopi's own modules keep their existing import path.
// The previous local copy filtered on `type IN ('table','virtual table')`, but
// SQLite registers FTS5/vec virtual tables with `type = 'table'`, so the extra
// literal never matched; the shared owner uses the correct set.
export { tableExists } from "@veyyon/utils/sqlite";

/**
 * Batch size for building `... IN (?, ?, …)` clauses over a list of ids. SQLite
 * caps the number of bound parameters per statement (SQLITE_MAX_VARIABLE_NUMBER,
 * historically 999), so id lists are queried in batches well under that bound.
 * This is the ONE owner: `precomputedVectors` in both shmr.ts and beam/recall.ts
 * batch `memory_embeddings` lookups by this size.
 */
export const SQLITE_IN_CLAUSE_BATCH = 500;
