/**
 * Tests the shared Git baseline reader against the immutable pinned commit.
 *
 * Verifies that:
 * 1. Pinned baseline commit `aa14e0da82494dac5a06d240180cec88038a105f` is reachable.
 * 2. Missing/shallow baseline fails closed with actionable error text.
 * 3. Batched blob streaming reads data accurately, maps missing objects to null, and rejects malformed streams.
 * 4. Batched streaming rejects non-blob object headers (e.g. commits, trees).
 * 5. Tree listing and rename detection operate deterministically with null-safe `-z` parsing and strict validation.
 * 6. Single file reads distinguish missing path from fatal git errors.
 */

import { describe, expect, it } from "bun:test";
import {
	batchReadGitBlobs,
	ensureBaselineAvailable,
	getRenamePairs,
	PINNED_BASELINE_COMMIT,
	REPO_ROOT,
	readGitFileBuffer,
	readGitFileText,
	readGitTree,
} from "./git-baseline";

describe("git-baseline shared reader", () => {
	it("verifies the pinned baseline commit is available", () => {
		expect(PINNED_BASELINE_COMMIT).toBe("aa14e0da82494dac5a06d240180cec88038a105f");
		expect(() => ensureBaselineAvailable(REPO_ROOT, PINNED_BASELINE_COMMIT)).not.toThrow();
	});

	it("fails closed with actionable instructions when a baseline commit is missing", () => {
		const fakeCommit = "0000000000000000000000000000000000000000";
		expect(() => ensureBaselineAvailable(REPO_ROOT, fakeCommit)).toThrow(
			/The pinned baseline commit 0000000000000000000000000000000000000000 is not available.*git fetch origin 0000000000000000000000000000000000000000/s,
		);
	});

	it("reads tree listing from the baseline commit via null-safe ls-tree with strict shape validation", () => {
		const tree = readGitTree(PINNED_BASELINE_COMMIT, REPO_ROOT);
		expect(tree.size).toBeGreaterThan(5000);
		expect(tree.has("package.json")).toBe(true);
		expect(tree.has("packages/agent/package.json")).toBe(true);
		const pkg = tree.get("package.json");
		expect(pkg?.type).toBe("blob");
		expect(pkg?.mode).toBe("100644");
		expect(pkg?.sha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("reads single file text and buffer, returning null for missing path and throwing on invalid commit", () => {
		const rootPkg = readGitFileText("package.json", PINNED_BASELINE_COMMIT, REPO_ROOT);
		expect(rootPkg).not.toBeNull();
		expect(rootPkg).toContain("@veyyon");

		const rootBuf = readGitFileBuffer("package.json", PINNED_BASELINE_COMMIT, REPO_ROOT);
		expect(rootBuf).not.toBeNull();
		expect(rootBuf?.toString("utf-8")).toContain("@veyyon");

		const missing = readGitFileText("nonexistent-file-xyz.txt", PINNED_BASELINE_COMMIT, REPO_ROOT);
		expect(missing).toBeNull();

		// Invalid commit object throws fail-closed
		expect(() => readGitFileBuffer("package.json", "invalid_commit_name_12345", REPO_ROOT)).toThrow(
			/is not available|Failed to read git object/,
		);
	});

	it("streams batched blobs via git cat-file --batch -Z with exact fidelity", async () => {
		const specs = [
			`${PINNED_BASELINE_COMMIT}:package.json`,
			`${PINNED_BASELINE_COMMIT}:packages/agent/package.json`,
			`${PINNED_BASELINE_COMMIT}:nonexistent-file-12345.txt`,
		];

		const results = await batchReadGitBlobs(specs, REPO_ROOT);
		expect(results.size).toBe(3);

		const pkgBuffer = results.get(specs[0]);
		expect(pkgBuffer).toBeInstanceOf(Buffer);
		expect(pkgBuffer?.toString("utf-8")).toContain("@veyyon");

		const agentPkgBuffer = results.get(specs[1]);
		expect(agentPkgBuffer).toBeInstanceOf(Buffer);
		expect(agentPkgBuffer?.toString("utf-8")).toContain("@veyyon/agent-core");

		const missingBuffer = results.get(specs[2]);
		expect(missingBuffer).toBeNull();
	});

	it("fails closed when batch stream requests a non-blob object", async () => {
		// Pinned commit itself is a commit object, not a blob
		const commitSpec = PINNED_BASELINE_COMMIT;
		await expect(batchReadGitBlobs([commitSpec], REPO_ROOT)).rejects.toThrow(
			/returned non-blob object type "commit"/,
		);
	});

	it("returns empty map on empty batch request", async () => {
		const results = await batchReadGitBlobs([], REPO_ROOT);
		expect(results.size).toBe(0);
	});

	it("extracts rename pairs from the baseline commit to HEAD using null-safe diff", () => {
		const { pairs, deleted } = getRenamePairs(PINNED_BASELINE_COMMIT, "HEAD", REPO_ROOT, 20);
		expect(pairs.length).toBeGreaterThan(500);
		expect(deleted.length).toBeGreaterThan(0);
		const destinations = pairs.map(([, dest]) => dest);
		expect(destinations.some(d => d.startsWith("natives/"))).toBe(true);
		expect(destinations.some(d => d.startsWith("contracts/"))).toBe(true);
	});
});
