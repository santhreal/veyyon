/**
 * Locks src/project-vocab.ts, the runtime-cache orchestration a harness calls
 * instead of writing its own. This flow used to live in the veyyon harness; it
 * decides which dictionary a repository state gets (root resolution, git-HEAD vs
 * listing signature, try-cache-before-listing, budget keying, generate-on-miss),
 * so every harness must run it identically and it belongs to argot. These tests
 * drive it with a fake git IO and a real temp cache directory and assert the real
 * behavior: a genuine cache hit reads no listing, a HEAD change makes a new entry
 * while the old one survives, a non-default budget is a distinct entry, a non-git
 * `.argot` project resolves by walking, an unknown folder is `undefined`, an
 * invalid budget is surfaced and defaulted, and an inconsistent git IO fails loud
 * rather than silently degrading.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOKEN_BUDGET } from "../src/constants.js";
import {
	budgetKeyedSignature,
	type ProjectVocabIO,
	type ProjectVocabNotice,
	resolveProjectVocab,
	resolveTokenBudget,
} from "../src/project-vocab.js";

async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

async function write(root: string, rel: string, content: string): Promise<void> {
	const full = join(root, rel);
	const slash = full.lastIndexOf("/");
	if (slash !== -1) await mkdir(full.slice(0, slash), { recursive: true });
	await writeFile(full, content);
}

// A shared long path referenced across several files, so document-frequency
// scoring generates at least one real handle (a small corpus generates an empty
// dict, which is never written to the cache and would make every resolve miss).
const SHARED_PATH = "packages/server/src/database/connection.ts";

/**
 * Write a corpus that reliably yields a non-empty dictionary and return its
 * tracked-file list: four modules that each import {@link SHARED_PATH}, giving
 * that string a high document frequency, plus the file itself.
 */
async function writeRichCorpus(root: string): Promise<string[]> {
	const importers = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
	for (const rel of importers) {
		await write(root, rel, `import { conn } from "${SHARED_PATH}";\nexport const use_${rel.length} = conn;\n`);
	}
	await write(root, SHARED_PATH, "export const conn = {};\n");
	return [...importers, SHARED_PATH];
}

/** A git IO whose HEAD and tracked-file list are set by the test, counting calls. */
function fakeGit(state: {
	head: string | null;
	files: string[];
}): ProjectVocabIO & { headCalls: number; listCalls: number } {
	const io = {
		headCalls: 0,
		listCalls: 0,
		async gitHead() {
			io.headCalls += 1;
			return state.head;
		},
		async listTrackedFiles() {
			io.listCalls += 1;
			return state.head === null ? null : state.files;
		},
	};
	return io;
}

describe("resolveTokenBudget", () => {
	it("uses a finite positive number verbatim (floored)", () => {
		expect(resolveTokenBudget(4000)).toBe(4000);
		expect(resolveTokenBudget(999.9)).toBe(999);
	});

	it("defaults for undefined without a notice", () => {
		const notices: ProjectVocabNotice[] = [];
		expect(resolveTokenBudget(undefined, n => notices.push(n))).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toEqual([]);
	});

	it("surfaces an invalid budget and defaults, never a silent empty dict", () => {
		for (const bad of [0, -5, Number.NaN]) {
			const notices: ProjectVocabNotice[] = [];
			expect(resolveTokenBudget(bad, n => notices.push(n))).toBe(DEFAULT_TOKEN_BUDGET);
			expect(notices).toHaveLength(1);
			expect(notices[0]?.code).toBe("invalid-token-budget");
		}
	});
});

describe("budgetKeyedSignature", () => {
	it("maps the default budget to the bare signature so existing caches still hit", () => {
		expect(budgetKeyedSignature("abc123", DEFAULT_TOKEN_BUDGET)).toBe("abc123");
	});

	it("derives a distinct, stable signature for a non-default budget", () => {
		const a = budgetKeyedSignature("abc123", 4000);
		const b = budgetKeyedSignature("abc123", 4000);
		expect(a).toBe(b);
		expect(a).not.toBe("abc123");
		expect(budgetKeyedSignature("abc123", 40)).not.toBe(a);
	});
});

describe("resolveProjectVocab", () => {
	it("returns undefined for a folder with no project marker (nothing to arm)", async () => {
		const plain = await tempDir("argot-pv-plain-");
		const cacheDir = await tempDir("argot-pv-cache-");
		const io = fakeGit({ head: null, files: [] });
		expect(await resolveProjectVocab({ folder: plain, cacheDir, io })).toBeUndefined();
	});

	it("generates from a git project's tracked files and resolves the root", async () => {
		const root = await tempDir("argot-pv-git-");
		await write(root, ".git/HEAD", "ref: refs/heads/main");
		await write(root, "src/database/connection.ts", "import x");
		const cacheDir = await tempDir("argot-pv-cache-");
		const io = fakeGit({ head: "deadbeef", files: ["src/database/connection.ts"] });

		const resolved = await resolveProjectVocab({ folder: root, cacheDir, io });
		expect(resolved?.root).toBe(root);
		expect(resolved?.vocab).toBeDefined();
		expect(io.headCalls).toBe(1);
		expect(io.listCalls).toBe(1); // a miss listed the tree
	});

	it("hits the cache on a second resolve at the same HEAD and never lists the tree again", async () => {
		const root = await tempDir("argot-pv-hit-");
		await write(root, ".git/HEAD", "ref: refs/heads/main");
		const files = await writeRichCorpus(root);
		const cacheDir = await tempDir("argot-pv-cache-");
		const io = fakeGit({ head: "cafef00d", files });

		const first = await resolveProjectVocab({ folder: root, cacheDir, io });
		expect(first?.vocab.handles.size).toBeGreaterThan(0); // proves an entry was written
		const listAfterFirst = io.listCalls;
		await resolveProjectVocab({ folder: root, cacheDir, io });
		expect(io.listCalls).toBe(listAfterFirst); // no new listing on the hit
	});

	it("writes a fresh entry for a new HEAD and leaves the old entry intact", async () => {
		const root = await tempDir("argot-pv-head-");
		await write(root, ".git/HEAD", "ref: refs/heads/main");
		const files = await writeRichCorpus(root);
		const cacheDir = await tempDir("argot-pv-cache-");

		const first = fakeGit({ head: "1111111", files });
		await resolveProjectVocab({ folder: root, cacheDir, io: first });

		const second = fakeGit({ head: "2222222", files: [...files, "src/e.ts"] });
		await resolveProjectVocab({ folder: root, cacheDir, io: second });

		// The original HEAD's entry is still a hit (untouched), proving immutability.
		const again = fakeGit({ head: "1111111", files });
		const beforeList = again.listCalls;
		await resolveProjectVocab({ folder: root, cacheDir, io: again });
		expect(again.listCalls).toBe(beforeList); // hit, old entry survived
	});

	it("keys a non-default budget to a distinct entry from the default at the same HEAD", async () => {
		const root = await tempDir("argot-pv-budget-");
		await write(root, ".git/HEAD", "ref: refs/heads/main");
		const files = await writeRichCorpus(root);
		const cacheDir = await tempDir("argot-pv-cache-");

		const io = fakeGit({ head: "abcabc", files });
		await resolveProjectVocab({ folder: root, cacheDir, io }); // default budget entry
		const listAfterDefault = io.listCalls;
		// A non-default budget must MISS (distinct entry) and list again.
		await resolveProjectVocab({ folder: root, cacheDir, io, tokenBudget: 40 });
		expect(io.listCalls).toBe(listAfterDefault + 1);
	});

	it("resolves a non-git `.argot` project by walking the tree itself (no git IO listing)", async () => {
		const root = await tempDir("argot-pv-nogit-");
		await write(root, ".argot", "");
		await write(root, "src/config.ts", "export const port = 3000");
		const cacheDir = await tempDir("argot-pv-cache-");
		const io = fakeGit({ head: null, files: [] });

		const resolved = await resolveProjectVocab({ folder: root, cacheDir, io });
		expect(resolved?.root).toBe(root);
		expect(resolved?.vocab).toBeDefined();
		expect(io.listCalls).toBe(0); // non-git path never asks git for a listing
	});

	it("fails loud when git IO is inconsistent (HEAD present but listing null), never degrading", async () => {
		const root = await tempDir("argot-pv-bad-");
		await write(root, ".git/HEAD", "ref: refs/heads/main");
		const cacheDir = await tempDir("argot-pv-cache-");
		const io: ProjectVocabIO = {
			async gitHead() {
				return "somehead";
			},
			async listTrackedFiles() {
				return null; // inconsistent: claims git via head, denies via listing
			},
		};
		await expect(resolveProjectVocab({ folder: root, cacheDir, io })).rejects.toThrow(/inconsistent/);
	});

	it("surfaces an invalid token budget through onNotice and still produces a vocab", async () => {
		const root = await tempDir("argot-pv-invalidbudget-");
		await write(root, ".git/HEAD", "ref: refs/heads/main");
		await write(root, "src/a.ts", "aaa");
		const cacheDir = await tempDir("argot-pv-cache-");
		const io = fakeGit({ head: "beadbead", files: ["src/a.ts"] });
		const notices: ProjectVocabNotice[] = [];

		const resolved = await resolveProjectVocab({
			folder: root,
			cacheDir,
			io,
			tokenBudget: -1,
			onNotice: n => notices.push(n),
		});
		expect(resolved?.vocab).toBeDefined();
		expect(notices.some(n => n.code === "invalid-token-budget")).toBe(true);
	});
});
