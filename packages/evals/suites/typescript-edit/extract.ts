import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { typescriptEditCacheDir, typescriptEditFixturesArchive } from "./paths";

export interface FixturesArchiveInfo {
	readonly ok: true;
	readonly path: string;
	readonly buffer: Buffer;
	readonly sha: string;
	readonly size: number;
	readonly mtime: Date;
	readonly fileCount: number;
}

export interface FixturesArchiveMissing {
	readonly ok: false;
	readonly path: string;
	readonly error: string;
	readonly failure: FixtureArchiveFailure;
}

/** Every way the fixtures archive can be unusable, in the order a read encounters them. */
export const FIXTURE_ARCHIVE_FAILURES = ["not-a-file", "empty", "no-files", "unreadable"] as const;

export type FixtureArchiveFailure = (typeof FIXTURE_ARCHIVE_FAILURES)[number];

/**
 * Refusal from the one reader of the fixtures archive. It carries the classification, so a caller
 * mapping a refusal to its own vocabulary reads a field instead of matching substrings of a message
 * this module wrote.
 */
export class FixtureArchiveError extends Error {
	readonly failure: FixtureArchiveFailure;
	readonly archivePath: string;

	constructor(failure: FixtureArchiveFailure, archivePath: string, message: string) {
		super(message);
		this.name = "FixtureArchiveError";
		this.failure = failure;
		this.archivePath = archivePath;
	}
}

export type FixturesArchiveResult = FixturesArchiveInfo | FixturesArchiveMissing;

export interface ReadFixturesArchiveOptions {
	readonly archivePath?: string;
	readonly allowMissingArchive?: boolean;
}

export interface ExtractFixturesOptions {
	readonly archivePath?: string;
	readonly allowMissingArchive?: boolean;
	readonly cacheDir?: string;
}

export interface ExtractedFixtures {
	readonly dir: string;
	readonly archivePath: string;
	readonly sha: string;
	readonly cleanup: () => Promise<void>;
}

/**
 * Reads, validates, and computes the SHA-256 digest of the TypeScript edit fixtures archive.
 * Fails closed with a named Error by default unless `allowMissingArchive: true` is passed.
 */
export async function readFixturesArchive(options: ReadFixturesArchiveOptions = {}): Promise<FixturesArchiveResult> {
	const archivePath = options.archivePath ? path.resolve(options.archivePath) : typescriptEditFixturesArchive();

	try {
		const stat = await fs.stat(archivePath);
		if (!stat.isFile()) {
			throw new FixtureArchiveError(
				"not-a-file",
				archivePath,
				`TypeScript edit fixture archive at ${archivePath} is not a file. Ensure datasets/typescript-edit/fixtures.tar.gz exists.`,
			);
		}
		if (stat.size === 0) {
			throw new FixtureArchiveError(
				"empty",
				archivePath,
				`TypeScript edit fixture archive at ${archivePath} is empty (0 bytes). Re-generate or restore datasets/typescript-edit/fixtures.tar.gz.`,
			);
		}

		const buffer = await fs.readFile(archivePath);
		const hash = createHash("sha256").update(buffer).digest("hex");

		const archive = new Bun.Archive(buffer.buffer);
		const files = await archive.files();
		if (files.size === 0) {
			throw new FixtureArchiveError(
				"no-files",
				archivePath,
				`TypeScript edit fixture archive at ${archivePath} contains no files.`,
			);
		}

		return {
			ok: true,
			path: archivePath,
			buffer,
			sha: hash,
			size: stat.size,
			mtime: stat.mtime,
			fileCount: files.size,
		};
	} catch (error) {
		const refusal =
			error instanceof FixtureArchiveError
				? error
				: new FixtureArchiveError(
						"unreadable",
						archivePath,
						`TypeScript edit fixtures archive not found or unreadable at "${archivePath}": ${errorMessage(error)}`,
					);
		if (options.allowMissingArchive === true) {
			return { ok: false, path: archivePath, error: refusal.message, failure: refusal.failure };
		}
		throw refusal;
	}
}

/**
 * Extracts the TypeScript edit fixtures archive into a cached directory.
 * Returns the directory containing the task fixtures and a cleanup no-op.
 */
export async function extractFixtures(options: ExtractFixturesOptions = {}): Promise<ExtractedFixtures> {
	const archiveResult = await readFixturesArchive({
		archivePath: options.archivePath,
		allowMissingArchive: options.allowMissingArchive,
	});

	if (!archiveResult.ok) {
		throw new Error(
			`TypeScript edit fixtures archive not found or unreadable at "${archiveResult.path}": ${archiveResult.error}`,
		);
	}

	const cacheRoot = options.cacheDir ?? typescriptEditCacheDir();
	await fs.mkdir(cacheRoot, { recursive: true });

	const hashPrefix = archiveResult.sha.slice(0, 16);
	const targetDir = path.join(cacheRoot, hashPrefix);

	const targetStat = await fs.stat(targetDir).catch(() => null);
	if (targetStat?.isDirectory()) {
		const entries = await fs.readdir(targetDir, { withFileTypes: true });
		if (entries.length > 0) {
			const dirs = entries.filter(entry => entry.isDirectory());
			const files = entries.filter(entry => entry.isFile());
			const finalDir = dirs.length === 1 && files.length === 0 ? path.join(targetDir, dirs[0]!.name) : targetDir;
			return {
				dir: finalDir,
				archivePath: archiveResult.path,
				sha: archiveResult.sha,
				cleanup: async () => {},
			};
		}
	}

	const stagingDir = path.join(
		cacheRoot,
		`staging-${hashPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await fs.mkdir(stagingDir, { recursive: true });

	const archive = new Bun.Archive(archiveResult.buffer.buffer);
	for (const [filePath, file] of await archive.files()) {
		const fullPath = path.join(stagingDir, filePath);
		await fs.mkdir(path.dirname(fullPath), { recursive: true });
		await fs.writeFile(fullPath, Buffer.from(await file.arrayBuffer()));
	}

	try {
		await fs.rename(stagingDir, targetDir);
	} catch {
		await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
	}

	const entries = await fs.readdir(targetDir, { withFileTypes: true });
	const dirs = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	const finalDir = dirs.length === 1 && files.length === 0 ? path.join(targetDir, dirs[0]!.name) : targetDir;

	return {
		dir: finalDir,
		archivePath: archiveResult.path,
		sha: archiveResult.sha,
		cleanup: async () => {},
	};
}

/**
 * Ensures the fixtures archive is extracted and returns the path to the fixtures directory.
 */
export async function ensureFixturesExtracted(
	archivePath?: string,
	options: Omit<ExtractFixturesOptions, "archivePath"> = {},
): Promise<string> {
	const extracted = await extractFixtures({ ...options, archivePath });
	return extracted.dir;
}

/**
 * Extract the bundled fixture tasks into a directory containing task folders.
 * Compatible with existing benchmark caller signatures returning `{ dir, cleanup }`.
 */
export async function extractBenchmarkFixtures(
	options: ExtractFixturesOptions = {},
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const extracted = await extractFixtures(options);
	return {
		dir: extracted.dir,
		cleanup: extracted.cleanup,
	};
}
