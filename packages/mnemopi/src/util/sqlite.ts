// tableExists is a generic sqlite helper with one home in the shared lib. It is
// re-exported here so mnemopi's own modules keep their existing import path.
// The previous local copy filtered on `type IN ('table','virtual table')`, but
// SQLite registers FTS5/vec virtual tables with `type = 'table'`, so the extra
// literal never matched; the shared owner uses the correct set.
export { tableExists } from "@veyyon/utils/sqlite";
