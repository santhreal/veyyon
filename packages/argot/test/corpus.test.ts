/**
 * Locks src/corpus.ts, the dict-quality policy that decides which project files
 * the generator learns from. This logic used to live in the veyyon harness; it is
 * codec quality (it decides which handles exist), so it belongs to argot and must
 * behave identically for every harness. These tests assert the real decisions on
 * a real temp filesystem: lockfiles and assets contribute their path but never
 * their content, source files contribute bounded content, binary (NUL-byte)
 * content is dropped, the total budget is respected and surfaced (never a silent
 * truncation), gathering is deterministic, and the non-git walk ignores VCS and
 * build output. A regression to any threshold or skip-list changes which handles
 * a project gets, so it goes red here.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CorpusNotice,
	gatherRepoFiles,
	MAX_FILE_CONTENT_BYTES,
	shouldScanContent,
	TOTAL_CONTENT_BUDGET_BYTES,
	WALK_FILE_CAP,
	walkProjectTree,
} from "../src/corpus.js";

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "argot-corpus-"));
}

async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
	const full = join(root, rel);
	const slash = full.lastIndexOf("/");
	if (slash !== -1) await mkdir(full.slice(0, slash), { recursive: true });
	await writeFile(full, content);
}

describe("shouldScanContent", () => {
	it("scans ordinary source files", () => {
		expect(shouldScanContent("src/db.ts")).toBe(true);
		expect(shouldScanContent("packages/server/config.json")).toBe(true);
	});

	it("never scans machine-generated lockfiles (path still proposed elsewhere)", () => {
		for (const lock of ["Cargo.lock", "package-lock.json", "bun.lock", "go.sum", "pnpm-lock.yaml"]) {
			expect(shouldScanContent(`some/dir/${lock}`)).toBe(false);
		}
	});

	it("never scans asset, image, archive, or minified suffixes, case-insensitively", () => {
		for (const p of ["logo.SVG", "app.min.js", "bundle.MAP", "font.woff2", "photo.png", "a.tar.gz", "lib.wasm"]) {
			expect(shouldScanContent(p)).toBe(false);
		}
	});
});

describe("gatherRepoFiles", () => {
	it("reads content for source files and only the path for skipped files", async () => {
		const root = await tempRoot();
		await write(root, "src/db.ts", "export const db = 1;");
		await write(root, "Cargo.lock", "name = 'x'\n".repeat(500));
		await write(root, "logo.svg", "<svg></svg>");

		const files = await gatherRepoFiles(root, ["src/db.ts", "Cargo.lock", "logo.svg"]);
		const byPath = new Map(files.map(f => [f.path, f]));
		expect(byPath.get("src/db.ts")?.content).toBe("export const db = 1;");
		expect(byPath.get("Cargo.lock")?.content).toBeUndefined();
		expect(byPath.get("logo.svg")?.content).toBeUndefined();
		// Every path enters as a candidate regardless of content.
		expect(files.map(f => f.path).sort()).toEqual(["Cargo.lock", "logo.svg", "src/db.ts"]);
	});

	it("truncates a file longer than MAX_FILE_CONTENT_BYTES to that prefix", async () => {
		const root = await tempRoot();
		const big = "a".repeat(MAX_FILE_CONTENT_BYTES + 5000);
		await write(root, "big.ts", big);

		const [file] = await gatherRepoFiles(root, ["big.ts"]);
		expect(file?.content?.length).toBe(MAX_FILE_CONTENT_BYTES);
	});

	it("drops content with an embedded NUL byte to path-only (binary sniff)", async () => {
		const root = await tempRoot();
		await write(root, "data.ts", Buffer.from([0x61, 0x00, 0x62])); // a\0b, a .ts suffix that is really binary
		const [file] = await gatherRepoFiles(root, ["data.ts"]);
		expect(file).toEqual({ path: "data.ts" });
	});

	it("falls back to path-only for an unreadable file without failing the gather", async () => {
		const root = await tempRoot();
		const files = await gatherRepoFiles(root, ["does/not/exist.ts"]);
		expect(files).toEqual([{ path: "does/not/exist.ts" }]);
	});

	it("is deterministic: output is sorted by path regardless of input order", async () => {
		const root = await tempRoot();
		await write(root, "a.ts", "a");
		await write(root, "b.ts", "b");
		await write(root, "c.ts", "c");
		const files = await gatherRepoFiles(root, ["c.ts", "a.ts", "b.ts"]);
		expect(files.map(f => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("does not emit a content-budget notice for a small corpus", async () => {
		const root = await tempRoot();
		await write(root, "a.ts", "small");
		const notices: CorpusNotice[] = [];
		await gatherRepoFiles(root, ["a.ts"], n => notices.push(n));
		expect(notices).toEqual([]);
	});

	it("stops scanning content at the total budget and surfaces it loudly, not silently", async () => {
		// Each file contributes at most MAX_FILE_CONTENT_BYTES to the running total
		// (content is sliced to that prefix before counting), so it takes
		// TOTAL_CONTENT_BUDGET_BYTES / MAX_FILE_CONTENT_BYTES full-size files to
		// exhaust the budget. Write two past that many; the surplus files must drop
		// to path-only WITH a notice, never a silent truncation.
		const root = await tempRoot();
		const filesToBudget = Math.ceil(TOTAL_CONTENT_BUDGET_BYTES / MAX_FILE_CONTENT_BYTES);
		const total = filesToBudget + 2;
		const chunk = "x".repeat(MAX_FILE_CONTENT_BYTES);
		const paths: string[] = [];
		for (let i = 0; i < total; i++) {
			// Zero-pad so lexical sort matches numeric order (the read order under budget).
			const rel = `f${String(i).padStart(4, "0")}.ts`;
			paths.push(rel);
			await write(root, rel, chunk);
		}
		const notices: CorpusNotice[] = [];
		const files = await gatherRepoFiles(root, paths, n => notices.push(n));

		const withContent = files.filter(f => f.content !== undefined).length;
		expect(withContent).toBe(filesToBudget); // exactly the budget's worth scanned
		expect(withContent).toBeLessThan(total); // the surplus dropped to path-only
		expect(notices).toHaveLength(1);
		expect(notices[0]?.code).toBe("content-budget-reached");
		expect(notices[0]?.data.totalFiles).toBe(total);
	});
});

describe("walkProjectTree", () => {
	it("lists files recursively while ignoring VCS, deps, build output, and dotfiles (except .argot)", async () => {
		const root = await tempRoot();
		await write(root, "src/index.ts", "1");
		await write(root, "src/util/helper.ts", "2");
		await write(root, ".argot", "");
		await write(root, ".git/config", "ignored");
		await write(root, "node_modules/dep/index.js", "ignored");
		await write(root, "dist/out.js", "ignored");
		await write(root, "target/debug/bin", "ignored");
		await write(root, ".env", "ignored-dotfile");

		const paths = (await walkProjectTree(root)).sort();
		expect(paths).toEqual([".argot", "src/index.ts", "src/util/helper.ts"]);
	});

	it("returns at most WALK_FILE_CAP files from a large tree", async () => {
		const root = await tempRoot();
		await mkdir(join(root, "many"), { recursive: true });
		const writes: Promise<void>[] = [];
		for (let i = 0; i < WALK_FILE_CAP + 50; i++) {
			writes.push(writeFile(join(root, "many", `f${i}.ts`), "x"));
		}
		await Promise.all(writes);
		const paths = await walkProjectTree(root);
		expect(paths.length).toBeLessThanOrEqual(WALK_FILE_CAP);
	});
});
