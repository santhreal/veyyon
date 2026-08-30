/**
 * WHY: a DeepSWE trial ran nine agent sessions against a container whose glibc
 * was older than the shipped addon required. Every candidate `.node` failed to
 * load, `listWorkspace` threw on the first call, and the three tree builders in
 * `workspace-tree.ts` caught it and returned an empty tree. The read tool then
 * rendered that zero-line tree as "(empty directory)". `/app` held a full httpx
 * checkout with thirteen top-level entries. Every session's first tool call was
 * `read .`, so every session started from "this workspace is empty", spent its
 * whole bound looking for the repository it was standing in, and produced a
 * zero-byte patch.
 *
 * The class this closes: a native scan that could not run is reported as a
 * finding. The scan produced no information, so the only correct answers are
 * the failure itself or a benign empty for a directory that really has no
 * entries — never the second for the first.
 *
 * Covered here: every exported tree builder, both of the read tool's listing
 * paths, and a fail-by-default sweep that turns red when a new builder is
 * exported without a propagation test.
 *
 * NOT covered here: whether the addon loads on a given host. That is
 * `natives/bridge/bindings`' portability surface. This suite pins what happens to a
 * caller once it cannot.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import * as workspaceTree from "@veyyon/coding-agent/workspace-tree";
import * as natives from "@veyyon/natives";
import { markNativeAddonUnavailable } from "@veyyon/natives/loader-state";
import { removeWithRetries } from "@veyyon/utils";

const ADDON_MESSAGE = "Failed to load veyyon_natives native addon for linux-x64 (modern).";

/** The shape the real loader throws once no candidate addon loads. */
function unavailable(): Error {
	const error = new Error(ADDON_MESSAGE);
	markNativeAddonUnavailable(error);
	return error;
}

/** A scan failure that is NOT an addon failure: a directory that is gone. */
function benign(): Error {
	return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
	};
}

/**
 * Every builder whose empty-on-failure branch this suite drives, bound by hand
 * so the sweep below can compare these names against what the module actually
 * exports. A new builder lands red until it appears here with its own cases.
 */
const COVERED_BUILDERS = {
	buildDirectoryTree: workspaceTree.buildDirectoryTree,
	buildTopLevelDirectoryListing: workspaceTree.buildTopLevelDirectoryListing,
	buildWorkspaceTree: workspaceTree.buildWorkspaceTree,
} as const;

describe("a native addon that cannot load is never reported as an empty workspace", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "addon-unavailable-listing-"));
		// Thirteen entries, as the httpx checkout had, so an "empty directory"
		// answer here is unambiguously wrong rather than merely unlucky.
		await fs.mkdir(path.join(cwd, "httpx"), { recursive: true });
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await fs.writeFile(path.join(cwd, "pyproject.toml"), '[project]\nname = "httpx"\n');
		await fs.writeFile(path.join(cwd, "httpx", "_models.py"), "class Response:\n    pass\n");
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("exports no tree builder this suite does not drive", () => {
		const exported = Object.entries(workspaceTree)
			.filter(([name, value]) => typeof value === "function" && name.startsWith("build"))
			.map(([name]) => name)
			.sort();

		expect(exported).toEqual(Object.keys(COVERED_BUILDERS).sort());
	});

	it("lists the real entries while the addon loads, so an empty answer is a signal", async () => {
		const listing = await workspaceTree.buildTopLevelDirectoryListing(cwd);

		expect(listing.totalLines).toBeGreaterThan(1);
		expect(listing.rendered).toContain("pyproject.toml");
	});

	describe.each(Object.entries(COVERED_BUILDERS))("%s", (_name, build) => {
		it("propagates the load failure instead of answering with an empty tree", async () => {
			const scan = spyOn(natives, "listWorkspace").mockImplementation(() => {
				throw unavailable();
			});

			try {
				await expect(build(cwd)).rejects.toThrow(ADDON_MESSAGE);
			} finally {
				scan.mockRestore();
			}
		});

		it("still answers with an empty tree when the directory itself is the failure", async () => {
			const scan = spyOn(natives, "listWorkspace").mockImplementation(() => {
				throw benign();
			});

			try {
				const tree = await build(cwd);
				expect(tree.totalLines).toBe(0);
				expect(tree.rendered).toBe("");
			} finally {
				scan.mockRestore();
			}
		});
	});

	// Both listing paths, because the concise root path had no error handler at
	// all: `read .` at the session root is exactly the call every trial made.
	describe.each([
		["the concise working-directory root listing", { path: "." }],
		["the recursive listing", { path: ".", depth: 2 }],
		["a named subdirectory", { path: "httpx" }],
	])("the read tool on %s", (_label, args) => {
		it("reports the load failure and never claims the directory is empty", async () => {
			const tool = new ReadTool(createSession(cwd));
			const scan = spyOn(natives, "listWorkspace").mockImplementation(() => {
				throw unavailable();
			});

			try {
				const call = tool.execute("call-unavailable-addon", args);
				await expect(call).rejects.toThrow(ADDON_MESSAGE);
				await expect(call).rejects.toThrow("Cannot read directory");
			} finally {
				scan.mockRestore();
			}
		});
	});
});
