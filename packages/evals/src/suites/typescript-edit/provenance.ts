import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SuiteProvenance } from "../../core/types";
import { typescriptEditFixturesArchive } from "../../paths";
import { listFiles } from "./shared";

export const TYPESCRIPT_EDIT_VERSION = "1.0.0";
export const TYPESCRIPT_EDIT_SUITE_NAME = "typescript-edit";
export const DEFAULT_FIXTURES_ARCHIVE_RELATIVE = "datasets/typescript-edit/fixtures.tar.gz";

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
		const stat = await fs.stat(options.archivePath);
		const buffer = await fs.readFile(options.archivePath);
		const hash = createHash("sha256").update(buffer).digest("hex");

		return {
			suite: TYPESCRIPT_EDIT_SUITE_NAME,
			version,
			sha: hash,
			sourceUrl: DEFAULT_FIXTURES_ARCHIVE_RELATIVE,
			metadata: {
				archivePath: options.archivePath,
				contentHash: hash,
				sizeBytes: stat.size,
				mtime: stat.mtime.toISOString(),
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
	const defaultArchive = typescriptEditFixturesArchive();
	try {
		const stat = await fs.stat(defaultArchive);
		const buffer = await fs.readFile(defaultArchive);
		const hash = createHash("sha256").update(buffer).digest("hex");

		return {
			suite: TYPESCRIPT_EDIT_SUITE_NAME,
			version,
			sha: hash,
			sourceUrl: DEFAULT_FIXTURES_ARCHIVE_RELATIVE,
			metadata: {
				archivePath: defaultArchive,
				contentHash: hash,
				sizeBytes: stat.size,
				mtime: stat.mtime.toISOString(),
			},
		};
	} catch (error) {
		if (options.allowMissingArchive === true) {
			return {
				suite: TYPESCRIPT_EDIT_SUITE_NAME,
				version,
				sha: null,
				sourceUrl: DEFAULT_FIXTURES_ARCHIVE_RELATIVE,
				metadata: {
					archivePath: defaultArchive,
					error: error instanceof Error ? error.message : "Archive not found or unreadable",
				},
			};
		}
		const err = error instanceof Error ? error.message : String(error);
		throw new Error(`TypeScript edit fixtures archive not found or unreadable at "${defaultArchive}": ${err}`);
	}
}
