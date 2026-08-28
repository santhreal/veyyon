/**
 * Directory layout for the typescript-edit suite.
 *
 * The generic shapes are defined in `src/paths.ts`; this module states the suite name and the
 * fixtures archive name once, and derives every typescript-edit path from them. A leaf module: it
 * imports no other suite file, so `provenance.ts`, `extract.ts`, `generate.ts` and `suite.ts` can
 * all read the suite name from here.
 */
import * as path from "node:path";
import { suiteCacheDir, suiteDatasetDir } from "../../engine/package-paths";

/** Registered name of the typescript-edit suite, and its directory name under `datasets/`. */
export const TYPESCRIPT_EDIT_SUITE_NAME = "typescript-edit";

/** File name of the bundled fixtures archive. */
export const FIXTURES_ARCHIVE_NAME = "fixtures.tar.gz";

/** Bundled fixtures archive (`datasets/typescript-edit/fixtures.tar.gz`). */
export function typescriptEditFixturesArchive(): string {
	return path.join(suiteDatasetDir(TYPESCRIPT_EDIT_SUITE_NAME), FIXTURES_ARCHIVE_NAME);
}

/** Extraction cache for the fixtures archive (`.cache/datasets/typescript-edit`). */
export function typescriptEditCacheDir(): string {
	return suiteCacheDir(TYPESCRIPT_EDIT_SUITE_NAME);
}

/**
 * Package-relative location of the fixtures archive, as recorded in a provenance record's
 * `sourceUrl`. Always `/`-separated so a record is identical on every platform.
 */
export function typescriptEditFixturesArchiveRelative(): string {
	return path.posix.join("datasets", TYPESCRIPT_EDIT_SUITE_NAME, FIXTURES_ARCHIVE_NAME);
}
