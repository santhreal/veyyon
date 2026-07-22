import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolvePluginCommandPaths,
	resolvePluginHookPaths,
	resolvePluginManifestEntries,
} from "@veyyon/coding-agent/extensibility/plugins/loader";
import type { InstalledPlugin, PluginManifest } from "@veyyon/coding-agent/extensibility/plugins/types";

/**
 * resolvePluginManifestEntries decides which manifest entry points a plugin actually contributes,
 * gating feature entries by the plugin's enabledFeatures. It had no direct test even though a bug
 * here silently loads the wrong tools/hooks/commands (an opted-out feature leaking in, or a
 * default feature dropping out). These pin the feature-gating matrix and the resolvedPath contract
 * against a real on-disk plugin directory so the assertions are concrete file paths, not shapes.
 */

let dir: string;
const files = ["tools.js", "hooks.js", "cmd-base.js", "cmd-a.js", "cmd-b.js"];

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-plugin-entries-"));
	for (const f of files) fs.writeFileSync(path.join(dir, f), "// fixture");
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const plugin = (manifest: PluginManifest, enabledFeatures: string[] | null): InstalledPlugin => ({
	name: "p",
	version: "1",
	path: dir,
	manifest,
	enabledFeatures,
	enabled: true,
});

const features = {
	a: { default: true, commands: ["cmd-a.js"] },
	b: { default: false, commands: ["cmd-b.js"] },
};

/** Relative-to-fixture-dir view of resolved entries, for readable assertions. */
const rel = (entries: Array<{ entry: string; resolvedPath: string | null }>) =>
	entries.map(e => ({ entry: e.entry, resolvedPath: e.resolvedPath ? path.relative(dir, e.resolvedPath) : null }));

describe("resolvePluginManifestEntries feature gating", () => {
	it("returns only the base entry when the manifest declares no features", () => {
		expect(
			rel(resolvePluginManifestEntries(plugin({ version: "1", commands: ["cmd-base.js"] }, null), "commands")),
		).toEqual([{ entry: "cmd-base.js", resolvedPath: "cmd-base.js" }]);
	});

	it("adds only the entries of features named in enabledFeatures", () => {
		const manifest: PluginManifest = { version: "1", commands: ["cmd-base.js"], features };
		expect(rel(resolvePluginManifestEntries(plugin(manifest, ["a"]), "commands"))).toEqual([
			{ entry: "cmd-base.js", resolvedPath: "cmd-base.js" },
			{ entry: "cmd-a.js", resolvedPath: "cmd-a.js" },
		]);
		expect(rel(resolvePluginManifestEntries(plugin(manifest, ["b"]), "commands"))).toEqual([
			{ entry: "cmd-base.js", resolvedPath: "cmd-base.js" },
			{ entry: "cmd-b.js", resolvedPath: "cmd-b.js" },
		]);
	});

	it("enables only default:true features when enabledFeatures is null (use defaults)", () => {
		const manifest: PluginManifest = { version: "1", commands: ["cmd-base.js"], features };
		expect(rel(resolvePluginManifestEntries(plugin(manifest, null), "commands"))).toEqual([
			{ entry: "cmd-base.js", resolvedPath: "cmd-base.js" },
			{ entry: "cmd-a.js", resolvedPath: "cmd-a.js" },
		]);
	});

	it("enables no features when enabledFeatures is an empty array", () => {
		const manifest: PluginManifest = { version: "1", commands: ["cmd-base.js"], features };
		expect(rel(resolvePluginManifestEntries(plugin(manifest, []), "commands"))).toEqual([
			{ entry: "cmd-base.js", resolvedPath: "cmd-base.js" },
		]);
	});
});

describe("resolvePluginManifestEntries path resolution", () => {
	it("keeps a declared entry with a null resolvedPath when the file is missing", () => {
		expect(
			rel(resolvePluginManifestEntries(plugin({ version: "1", commands: ["nope.js"] }, null), "commands")),
		).toEqual([{ entry: "nope.js", resolvedPath: null }]);
	});

	it("accepts a single-string manifest entry (tools/hooks) as well as an array", () => {
		expect(rel(resolvePluginManifestEntries(plugin({ version: "1", tools: "tools.js" }, null), "tools"))).toEqual([
			{ entry: "tools.js", resolvedPath: "tools.js" },
		]);
	});
});

describe("resolvePluginHookPaths / resolvePluginCommandPaths", () => {
	it("returns the resolved absolute paths of hooks and commands (features flattened in)", () => {
		expect(
			resolvePluginHookPaths(plugin({ version: "1", hooks: "hooks.js" }, null)).map(p => path.relative(dir, p)),
		).toEqual(["hooks.js"]);
		const manifest: PluginManifest = { version: "1", commands: ["cmd-base.js"], features };
		expect(resolvePluginCommandPaths(plugin(manifest, ["a", "b"])).map(p => path.relative(dir, p))).toEqual([
			"cmd-base.js",
			"cmd-a.js",
			"cmd-b.js",
		]);
	});
});
