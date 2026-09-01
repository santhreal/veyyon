/**
 * WHY:
 *
 * File inspection actions (LoadFileTree, ReadFile, SearchFiles, OpenExternal) previously used
 * shallow or mock implementations that returned non-standard snapshot structures (e.g. emoji-decorated
 * text trees instead of FileNode entries), lacked confinement checks (allowing directory traversal),
 * omitted size/binary/truncation metadata on file content, and ran unbounded file searches.
 *
 * This test suite closes the class of defects by driving the real GUI host protocol against a live
 * filesystem, verifying:
 * - LoadFileTree produces a depth-first FileNode hierarchy respecting gitignore, bounding, and workspace confinement.
 * - ReadFile strictly checks workspace boundaries, accurately reports size and binary detection, and caps output bytes.
 * - SearchFiles utilizes native fuzzy/glob discovery while respecting gitignore and search limits.
 * - OpenExternal enforces workspace containment and reports launch failures.
 *
 * Gap: Remote SSH filesystem browsing and symlink loop cycle detection are handled by separate remote subsystems.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { READ_FILE_MAX_BYTES } from "../../src/gui-host/actions/files";
import type { FileContentView, FileTreeView, SearchResultsView } from "../../src/gui-host/wire";
import { TestSocketClient } from "./test-client";

describe("a file tree and content inspection behave correctly", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-files-test-"));

		// Structure:
		// .gitignore
		// hello.txt
		// src/
		//   app.ts
		//   nested/
		//     child.ts
		// ignored/
		//   secret.txt
		// test.ignored
		// link -> src/app.ts

		await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored/\n*.ignored\n", "utf8");
		await fs.writeFile(path.join(tempDir, "hello.txt"), "Hello, Veyyon GUI!", "utf8");
		await fs.mkdir(path.join(tempDir, "src", "nested"), { recursive: true });
		await fs.writeFile(path.join(tempDir, "src", "app.ts"), "export const x = 42;\n", "utf8");
		await fs.writeFile(path.join(tempDir, "src", "nested", "child.ts"), "export const child = true;\n", "utf8");

		await fs.mkdir(path.join(tempDir, "ignored"), { recursive: true });
		await fs.writeFile(path.join(tempDir, "ignored", "secret.txt"), "secret data\n", "utf8");
		await fs.writeFile(path.join(tempDir, "test.ignored"), "ignored data\n", "utf8");

		try {
			await fs.symlink(path.join(tempDir, "src", "app.ts"), path.join(tempDir, "link"));
		} catch {
			// Symlinks may not be supported on all environments, fallback to a regular file if so
			await fs.writeFile(path.join(tempDir, "link"), "link fallback", "utf8");
		}
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	test("LoadFileTree returns depth-first entries with gitignore filtering and confinement", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// Drain initial connection frames
		await client.nextFrame();
		await client.nextFrame();

		// 1. LoadFileTree from root
		const { frames: rootFrames, outcome: rootOutcome } = await client.request(1, { LoadFileTree: { root: null } });
		expect(rootOutcome).toEqual({ RequestSucceeded: { request: 1 } });

		const treeSnap = rootFrames.find(f => f.Snapshot?.FileTree)?.Snapshot?.FileTree as FileTreeView;
		expect(treeSnap).toBeDefined();
		expect(treeSnap.root).toBe(tempDir);
		expect(treeSnap.truncated).toBeFalse();

		// Check entries: gitignored files/directories must NOT be present
		const paths = treeSnap.entries.map(e => e.path);
		expect(paths.some(p => p.includes("ignored"))).toBeFalse();

		// Check depth-first ordering: 'src' followed by 'src/app.ts' and 'src/nested'
		const srcIndex = treeSnap.entries.findIndex(e => e.path === "src");
		const appIndex = treeSnap.entries.findIndex(e => e.path === "src/app.ts");
		const nestedIndex = treeSnap.entries.findIndex(e => e.path === "src/nested");
		const childIndex = treeSnap.entries.findIndex(e => e.path === "src/nested/child.ts");

		expect(srcIndex).toBeGreaterThanOrEqual(0);
		expect(appIndex).toBe(srcIndex + 1);
		expect(nestedIndex).toBe(appIndex + 1);
		expect(childIndex).toBe(nestedIndex + 1);

		expect(treeSnap.entries[srcIndex].depth).toBe(0);
		expect(treeSnap.entries[srcIndex].kind).toBe("Directory");
		expect(treeSnap.entries[appIndex].depth).toBe(1);
		expect(treeSnap.entries[appIndex].kind).toBe("File");
		expect(treeSnap.entries[nestedIndex].depth).toBe(1);
		expect(treeSnap.entries[nestedIndex].kind).toBe("Directory");
		expect(treeSnap.entries[childIndex].depth).toBe(2);
		expect(treeSnap.entries[childIndex].kind).toBe("File");

		// 2. LoadFileTree scoped to subdirectory
		const { frames: subFrames, outcome: subOutcome } = await client.request(2, { LoadFileTree: { root: "src" } });
		expect(subOutcome).toEqual({ RequestSucceeded: { request: 2 } });
		const subTree = subFrames.find(f => f.Snapshot?.FileTree)?.Snapshot?.FileTree as FileTreeView;
		expect(subTree).toBeDefined();
		expect(subTree.root).toBe(path.join(tempDir, "src"));
		expect(subTree.entries.map(e => e.path)).toEqual(["src/app.ts", "src/nested", "src/nested/child.ts"]);
		expect(subTree.entries[0].depth).toBe(0);

		// 3. LoadFileTree outside workspace
		const { outcome: outsideOutcome } = await client.request(3, { LoadFileTree: { root: "../outside" } });
		expect(outsideOutcome).toEqual({
			RequestFailed: {
				request: 3,
				error: expect.objectContaining({
					scope: "File",
					code: "OUTSIDE_WORKSPACE",
					retryable: false,
				}),
			},
		});

		// 4. LoadFileTree with missing directory
		const { outcome: missingOutcome } = await client.request(4, { LoadFileTree: { root: "nonexistent_dir" } });
		expect(missingOutcome).toEqual({
			RequestFailed: {
				request: 4,
				error: expect.objectContaining({
					scope: "File",
					code: "DIRECTORY_NOT_FOUND",
					retryable: false,
				}),
			},
		});

		client.destroy();
	});

	test("ReadFile correctly loads text, detects binary content, truncates large files, and enforces workspace boundaries", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		// 1. Regular text file
		const { frames: textFrames, outcome: textOutcome } = await client.request(1, { ReadFile: { path: "hello.txt" } });
		expect(textOutcome).toEqual({ RequestSucceeded: { request: 1 } });
		const textContent = textFrames.find(f => f.Snapshot?.FileContent)?.Snapshot?.FileContent as FileContentView;
		expect(textContent).toEqual({
			path: "hello.txt",
			content: "Hello, Veyyon GUI!",
			size_bytes: 18,
			truncated: false,
			binary: false,
		});

		// 2. Binary file (crafted file with NUL byte in the first 8 KiB)
		const binBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
		await fs.writeFile(path.join(tempDir, "binary.bin"), binBuffer);

		const { frames: binFrames, outcome: binOutcome } = await client.request(2, { ReadFile: { path: "binary.bin" } });
		expect(binOutcome).toEqual({ RequestSucceeded: { request: 2 } });
		const binContent = binFrames.find(f => f.Snapshot?.FileContent)?.Snapshot?.FileContent as FileContentView;
		expect(binContent).toEqual({
			path: "binary.bin",
			content: "",
			size_bytes: 11,
			truncated: false,
			binary: true,
		});

		// 3. Large file that exceeds READ_FILE_MAX_BYTES
		const largeSize = READ_FILE_MAX_BYTES + 1024;
		const largeBuffer = Buffer.alloc(largeSize, 0x61); // 'a' repeated
		await fs.writeFile(path.join(tempDir, "large.txt"), largeBuffer);

		const { frames: largeFrames, outcome: largeOutcome } = await client.request(3, {
			ReadFile: { path: "large.txt" },
		});
		expect(largeOutcome).toEqual({ RequestSucceeded: { request: 3 } });
		const largeContent = largeFrames.find(f => f.Snapshot?.FileContent)?.Snapshot?.FileContent as FileContentView;
		expect(largeContent.size_bytes).toBe(largeSize);
		expect(largeContent.truncated).toBeTrue();
		expect(largeContent.binary).toBeFalse();
		expect(largeContent.content.length).toBe(READ_FILE_MAX_BYTES);

		// 4. Missing file
		const { outcome: missingOutcome } = await client.request(4, { ReadFile: { path: "missing.txt" } });
		expect(missingOutcome).toEqual({
			RequestFailed: {
				request: 4,
				error: expect.objectContaining({
					scope: "File",
					code: "FILE_NOT_FOUND",
					message: expect.stringContaining("missing.txt"),
					retryable: false,
				}),
			},
		});

		// 5. Outside workspace (/etc/passwd style)
		const { outcome: outsideOutcome } = await client.request(5, { ReadFile: { path: "../etc/passwd" } });
		expect(outsideOutcome).toEqual({
			RequestFailed: {
				request: 5,
				error: expect.objectContaining({
					scope: "File",
					code: "OUTSIDE_WORKSPACE",
					retryable: false,
				}),
			},
		});

		client.destroy();
	});

	test("SearchFiles matches fuzzy and glob queries, ignores gitignore, and OpenExternal enforces confinement", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		// 1. Fuzzy search
		const { frames: fuzzyFrames, outcome: fuzzyOutcome } = await client.request(1, {
			SearchFiles: { query: "child" },
		});
		expect(fuzzyOutcome).toEqual({ RequestSucceeded: { request: 1 } });
		const fuzzyResults = fuzzyFrames.find(f => f.Snapshot?.SearchResults)?.Snapshot
			?.SearchResults as SearchResultsView;
		expect(fuzzyResults).toBeDefined();
		expect(fuzzyResults.query).toBe("child");
		expect(fuzzyResults.paths).toContain("src/nested/child.ts");
		expect(fuzzyResults.paths.some(p => p.includes("ignored"))).toBeFalse();

		// 2. Glob search
		const { frames: globFrames, outcome: globOutcome } = await client.request(2, { SearchFiles: { query: "*.ts" } });
		expect(globOutcome).toEqual({ RequestSucceeded: { request: 2 } });
		const globResults = globFrames.find(f => f.Snapshot?.SearchResults)?.Snapshot?.SearchResults as SearchResultsView;
		expect(globResults).toBeDefined();
		expect(globResults.paths).toContain("src/app.ts");
		expect(globResults.paths).toContain("src/nested/child.ts");

		// 3. Empty query search fails with INVALID_ARGUMENTS
		const { outcome: emptyOutcome } = await client.request(3, { SearchFiles: { query: "   " } });
		expect(emptyOutcome).toEqual({
			RequestFailed: {
				request: 3,
				error: expect.objectContaining({
					scope: "File",
					code: "INVALID_ARGUMENTS",
					retryable: false,
				}),
			},
		});

		// 4. OpenExternal on existing file succeeds
		const { outcome: openOutcome } = await client.request(4, { OpenExternal: { path: "hello.txt" } });
		expect(openOutcome).toEqual({ RequestSucceeded: { request: 4 } });

		// 5. OpenExternal outside workspace fails
		const { outcome: openOutsideOutcome } = await client.request(5, { OpenExternal: { path: "../etc/passwd" } });
		expect(openOutsideOutcome).toEqual({
			RequestFailed: {
				request: 5,
				error: expect.objectContaining({
					scope: "File",
					code: "OUTSIDE_WORKSPACE",
					retryable: false,
				}),
			},
		});

		// 6. OpenExternal on missing file fails
		const { outcome: openMissingOutcome } = await client.request(6, { OpenExternal: { path: "nonexistent.txt" } });
		expect(openMissingOutcome).toEqual({
			RequestFailed: {
				request: 6,
				error: expect.objectContaining({
					scope: "File",
					code: "FILE_NOT_FOUND",
					retryable: false,
				}),
			},
		});

		client.destroy();
	});
});
