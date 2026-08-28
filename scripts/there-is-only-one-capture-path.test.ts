// WHY THIS SUITE EXISTS
//
// This repository had two capture paths at once, and both documents describing
// them claimed to be the only authority: a recorder that drives a scene under
// `proof/scenes/` in a real terminal, and a tape-driven renderer with its own
// terminal, font and colour baseline. A proof pair produced by one did not match
// a pair produced by the other, so "the same surface, the same configuration,
// only the change differs" was unenforceable, and a reviewer reading the rules
// could not tell which arm of a pair was admissible. The tape path, its drivers,
// its image install and the `gallery --screenshot` flag that fed it were deleted.
//
// THE CLASS THIS CLOSES. Not "those six tapes": any second capture path
// reintroduced under the tape tool's name. A tape file, a path named after the
// tool, an install line in a container image, or a document that offers it as an
// alternative all fail here, so bringing it back costs a decision recorded in
// this file rather than a quiet commit.
//
// The tracked file list and every match are read at run time, so a new file or a
// new mention fails by default. The exemptions are pinned by exact equality: a
// second one cannot slip in beside the first.
//
// WHAT IT DOES NOT CATCH. A third capture path under some other name — a tool
// this suite has never heard of, or a hand-built frame — is invisible here.
// `docs/handbook/src/foundations/verification.md` is the authority for what a
// capture is, and it names exactly one path; a rule about one banned tool cannot
// enforce that on its own.
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");

/**
 * Files allowed to contain the tool's name, pinned by exact equality.
 *
 * The emoji table is upstream data: the videocassette emoji is spelled with the
 * same three letters and has nothing to do with recording a terminal. This suite
 * writes the name in its own header and patterns, so it exempts itself the way
 * `no-attribution-in-the-tree.test.ts` does.
 */
const ALLOWED_TO_NAME_IT = [
	"packages/coding-agent/src/modes/terminal/data/emojis.json",
	"scripts/there-is-only-one-capture-path.test.ts",
];

async function trackedFiles(): Promise<string[]> {
	const { stdout } = await run("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
	return stdout.split("\0").filter(entry => entry.length > 0);
}

/** Tracked files whose text names the tape tool as a word. Empty stdout on no match, exit 1. */
async function filesNamingTheTapeTool(): Promise<string[]> {
	try {
		const { stdout } = await run("git", ["grep", "-Iiln", "-e", "\\bvhs\\b"], {
			cwd: REPO_ROOT,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout.split("\n").filter(line => line.length > 0);
	} catch (err) {
		// `git grep` exits 1 with no output when nothing matches.
		const failure = err as { code?: number; stdout?: string };
		if (failure.code === 1 && !failure.stdout) return [];
		throw err;
	}
}

describe("one capture path", () => {
	it("tracks no tape file and no path named after the tape tool", async () => {
		const offenders = (await trackedFiles()).filter(
			file => file.endsWith(".tape") || /vhs/i.test(path.basename(file)),
		);
		expect(offenders).toEqual([]);
	});

	it("names the tape tool in no file but the two that are allowed to", async () => {
		expect((await filesNamingTheTapeTool()).sort()).toEqual([...ALLOWED_TO_NAME_IT].sort());
	});

	it("installs no tape tool in the recorder image", async () => {
		const dockerfile = await Bun.file(path.join(REPO_ROOT, "proof/docker/Dockerfile.recorder")).text();
		// The tool renders a tape in a headless browser driven over a websocket, so
		// its two companions are as good a signal as its own name.
		for (const marker of ["vhs", "ttyd", "ROD_BROWSER_BIN"]) {
			expect(dockerfile.toLowerCase()).not.toContain(marker.toLowerCase());
		}
	});
});
