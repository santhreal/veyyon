/**
 * WHY THIS SUITE EXISTS.
 *
 * `extract.ts` is the one reader of the typescript-edit fixtures archive, and it refuses four
 * distinguishable ways: the path is not a file, the file is zero bytes, the archive holds no
 * entries, or it cannot be read at all. The suite preflight re-derived that classification by
 * matching substrings of the message `extract.ts` had just written (`err.includes("not a file")`,
 * `"empty (0 bytes)"`, `"contains no files"`) and then rewrote the message with a second spelling
 * ("TypeScript-edit" beside "TypeScript edit"). Rewording either message silently demoted an
 * archive with no entries from `fixture-archive-contents` to the generic `fixture-archive`, and a
 * caller could not tell the two apart at all.
 *
 * The class this closes: a second reader of a refusal, recovering structure from prose. The reader
 * states the failure as a field (`FixtureArchiveError.failure`, `FixturesArchiveMissing.failure`),
 * every value is registered in `FIXTURE_ARCHIVE_FAILURES`, and the preflight maps the field through
 * one table. Adding a failure kind fails the type check on that table and turns the sweep below red.
 *
 * What it does not catch: whether an archive that reads clean holds usable tasks, which
 * `loadTasksFromDir` decides, and the fixtures-directory branch of the preflight.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { TempDir } from "@veyyon/utils";
import {
	FIXTURE_ARCHIVE_FAILURES,
	FixtureArchiveError,
	type FixtureArchiveFailure,
	readFixturesArchive,
} from "../../../src/suites/typescript-edit/extract";
import { TypescriptEditSuite } from "../../../src/suites/typescript-edit/suite";

/** A valid gzipped tar holding no entries: 10240 zero bytes is an empty archive. */
const EMPTY_TAR_GZ = gzipSync(Buffer.alloc(10240));

interface ArchiveCase {
	readonly failure: FixtureArchiveFailure;
	readonly requirement: string;
	/** Builds the archive path inside a temp directory. */
	readonly make: (dir: string) => Promise<string>;
}

const CASES: ArchiveCase[] = [
	{
		failure: "not-a-file",
		requirement: "fixture-archive",
		make: async dir => {
			const target = path.join(dir, "fixtures.tar.gz");
			await fs.mkdir(target);
			return target;
		},
	},
	{
		failure: "empty",
		requirement: "fixture-archive",
		make: async dir => {
			const target = path.join(dir, "fixtures.tar.gz");
			await fs.writeFile(target, "");
			return target;
		},
	},
	{
		failure: "no-files",
		requirement: "fixture-archive-contents",
		make: async dir => {
			const target = path.join(dir, "fixtures.tar.gz");
			await fs.writeFile(target, EMPTY_TAR_GZ);
			return target;
		},
	},
	{
		failure: "unreadable",
		requirement: "fixture-archive",
		make: async dir => path.join(dir, "absent", "fixtures.tar.gz"),
	},
];

async function withArchive<T>(build: ArchiveCase["make"], use: (archivePath: string) => Promise<T>): Promise<T> {
	const temp = await TempDir.create("@evals-test-archive-refusal-");
	try {
		return await use(await build(temp.absolute()));
	} finally {
		await temp.remove();
	}
}

describe("the one reader of the fixtures archive", () => {
	it("states which refusal it made, as a field rather than in prose alone", async () => {
		const observed: FixtureArchiveFailure[] = [];
		for (const testCase of CASES) {
			await withArchive(testCase.make, async archivePath => {
				const soft = await readFixturesArchive({ archivePath, allowMissingArchive: true });
				expect(soft.ok).toBe(false);
				if (soft.ok) return;
				expect(soft.failure).toBe(testCase.failure);
				expect(soft.path).toBe(archivePath);
				expect(soft.error).toContain(archivePath);
				observed.push(soft.failure);

				const thrown = await readFixturesArchive({ archivePath }).then(
					() => null,
					(error: unknown) => error,
				);
				expect(thrown).toBeInstanceOf(FixtureArchiveError);
				if (!(thrown instanceof FixtureArchiveError)) return;
				// The hard and soft paths refuse for the same reason with the same words.
				expect(thrown.failure).toBe(testCase.failure);
				expect(thrown.archivePath).toBe(archivePath);
				expect(thrown.message).toBe(soft.error);
			});
		}

		// A new failure kind that no case reaches turns this red instead of shipping unexercised.
		expect(observed.sort()).toEqual([...FIXTURE_ARCHIVE_FAILURES].sort());
	});
});

describe("the typescript-edit preflight", () => {
	it("reports the reader's own message and maps each refusal to its missing requirement", async () => {
		for (const testCase of CASES) {
			await withArchive(testCase.make, async archivePath => {
				const refusal = await readFixturesArchive({ archivePath, allowMissingArchive: true });
				expect(refusal.ok).toBe(false);
				if (refusal.ok) return;

				const verdict = await new TypescriptEditSuite({ defaultArchive: archivePath }).preflight();

				expect(verdict.ok).toBe(false);
				// Byte-identical: a second spelling of the same refusal is what drifted before.
				expect(verdict.reason).toBe(refusal.error);
				expect(verdict.missingRequirements).toEqual([testCase.requirement]);
			});
		}
	});
});
