/**
 * One owner for metaharness filesystem anchors. Import these instead of
 * re-deriving repo-relative paths: the jobs dir default was previously
 * defined independently in server.ts and runner.ts, and a drifted copy
 * would silently split the run store into two homes.
 */
import * as path from "node:path";

/** Monorepo root (three levels up from packages/metaharness/src). */
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/** Default home for all benchmark job dirs and the manager SQLite DB. */
export const DEFAULT_JOBS_DIR = path.join(REPO_ROOT, "runs", "harbor");
