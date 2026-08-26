import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listFiles } from "../../core/fs-walk";
import type { SuiteProvenance } from "../../core/types";
import { readFixturesArchive } from "./extract";
import { TYPESCRIPT_EDIT_SUITE_NAME, typescriptEditFixturesArchiveRelative } from "./paths";

export const TYPESCRIPT_EDIT_VERSION = "1.0.0";

const DEFAULT_FIXTURES_ARCHIVE_RELATIVE = typescriptEditFixturesArchiveRelative();

export interface TypescriptEditProvenanceOptions {
	readonly archivePath?: string;
	readonly fixturesDir?: string;
	readonly version?: string;
	/**
	 * Explicit opt-in to soft fallback returning `{ sha: null }` when the fixtures
	 * archive is missing or unreadable. By default, provenance computation fails closed.
	 */
	readonly allowMissingArchive?: boolean;
}

/**
 * Computes deterministic dataset provenance and content hash for the TypeScript edit benchmark.
 */
export async function computeTypescriptEditProvenance(
	options: TypescriptEditProvenanceOptions = {},
): Promise<SuiteProvenance> {
	const version = options.version ?? TYPESCRIPT_EDIT_VERSION;

	if (options.archivePath) {
		const archiveResult = await readFixturesArchive({
			archivePath: options.archivePath,
			allowMissingArchive: options.allowMissingArchive,
		});
		if (!archiveResult.ok) {
			return {
				suite: TYPESCRIPT_EDIT_SUITE_NAME,
				version,
				sha: null,
				sourceUrl: DEFAULT_FIXTURES_ARCHIVE_RELATIVE,
				metadata: {
					archivePath: archiveResult.path,
					error: archiveResult.error,
				},
			};
		}
		return {
			suite: TYPESCRIPT_EDIT_SUITE_NAME,
			version,
			sha: archiveResult.sha,
			sourceUrl: DEFAULT_FIXTURES_ARCHIVE_RELATIVE,
			metadata: {
				archivePath: options.archivePath,
				contentHash: archiveResult.sha,
				sizeBytes: archiveResult.size,
				mtime: archiveResult.mtime.toISOString(),
			},
		};
	}

	if (options.fixturesDir) {
		const files = await listFiles(options.fixturesDir);
		const hash = createHash("sha256");
		for (const rel of files) {
			hash.update(rel);
			const content = await fs.readFile(path.join(options.fixturesDir, rel));
			hash.update(content);
		}
		const digest = hash.digest("hex");

		return {
			suite: TYPESCRIPT_EDIT_SUITE_NAME,
			version,
			sha: digest,
			sourceUrl: options.fixturesDir,
			metadata: {
				fixturesDir: options.fixturesDir,
				contentHash: digest,
				fileCount: files.length,
			},
		};
	}

	// Default fallback to package datasets archive
	const archiveResult = await readFixturesArchive({
		allowMissingArchive: options.allowMissingArchive,
	});

	if (!archiveResult.ok) {
		return {
			suite: TYPESCRIPT_EDIT_SUITE_NAME,
			version,
			sha: null,
			sourceUrl: DEFAULT_FIXTURES_ARCHIVE_RELATIVE,
			metadata: {
				archivePath: archiveResult.path,
				error: archiveResult.error,
			},
		};
	}

	return {
		suite: TYPESCRIPT_EDIT_SUITE_NAME,
		version,
		sha: archiveResult.sha,
		sourceUrl: DEFAULT_FIXTURES_ARCHIVE_RELATIVE,
		metadata: {
			archivePath: archiveResult.path,
			contentHash: archiveResult.sha,
			sizeBytes: archiveResult.size,
			mtime: archiveResult.mtime.toISOString(),
		},
	};
}
