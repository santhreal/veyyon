/**
 * Every entry key a plugin manifest can declare is consumed by a loader.
 *
 * WHY THIS SUITE EXISTS. The manifest contract declares `tools`, `hooks`, `commands` and
 * `extensions`, and the plugin loader resolves all four to files. Only `tools` and `extensions`
 * were read by anything: `getAllPluginHookPaths` and `getAllPluginCommandPaths` existed, resolved
 * correctly, and had no caller. A plugin that shipped a hook or a command installed cleanly, passed
 * `plugin doctor`, and contributed nothing, with no report anywhere that two of its four declared
 * keys were decoration.
 *
 * THE CLASS THIS CLOSES. A manifest key with no consumer. The sweep runs over
 * `PLUGIN_MANIFEST_ENTRY_KEYS`, the loader's own run-time list, and installs one plugin declaring
 * one file per key; each key is then asserted to surface through the discovery function that
 * loads it. Adding a key to the list without a row in `CONSUMER` is a type error, and a row that
 * does not surface the file is a red test.
 *
 * WHAT IT DOES NOT CATCH. Whether the file, once imported, registers anything: that is the
 * extension runner's and the command loader's own suites. A key added to the `PluginManifest`
 * contract but not to `PLUGIN_MANIFEST_ENTRY_KEYS` is invisible here; the loader's key type is
 * what pins the two together.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { discoverCustomCommands } from "@veyyon/coding-agent/extensibility/custom-commands";
import { discoverCustomToolPaths } from "@veyyon/coding-agent/extensibility/custom-tools";
import { discoverExtensionPaths } from "@veyyon/coding-agent/extensibility/extensions";
import {
	PLUGIN_MANIFEST_ENTRY_KEYS,
	type PluginManifestEntryKey,
} from "@veyyon/coding-agent/extensibility/plugins/loader";
import { type ContextScopeFixture, useContextScopeFixture } from "../helpers/context-scope-fixture";

const fixture = useContextScopeFixture("plugin-manifest-keys-");

/** The discovery function that loads each key's files, given the fixture's cwd and agent dir. */
const CONSUMER: Record<PluginManifestEntryKey, (cwd: string, agentDir: string) => Promise<string[]>> = {
	tools: async (cwd, agentDir) => (await discoverCustomToolPaths([], cwd, agentDir)).map(entry => entry.path),
	hooks: (cwd, agentDir) => discoverExtensionPaths([], cwd, undefined, agentDir),
	commands: async (cwd, agentDir) => (await discoverCustomCommands({ cwd, agentDir })).paths.map(entry => entry.path),
	extensions: (cwd, agentDir) => discoverExtensionPaths([], cwd, undefined, agentDir),
};

/** One plugin declaring one file per manifest key; returns the absolute path each key resolves to. */
function installPluginDeclaringEveryKey(
	f: ContextScopeFixture,
	pluginsRoot: string,
): Record<PluginManifestEntryKey, string> {
	const name = "every-key";
	const pluginDir = path.join(pluginsRoot, "node_modules", name);
	const files = {} as Record<PluginManifestEntryKey, string>;
	const manifest: Record<string, string | string[]> = {};
	for (const key of PLUGIN_MANIFEST_ENTRY_KEYS) {
		files[key] = f.writeFile(path.join(pluginDir, `${key}-entry.ts`), "export default () => {};\n");
		// `tools` and `hooks` are single-string keys; `commands` and `extensions` are lists.
		manifest[key] = key === "tools" || key === "hooks" ? `${key}-entry.ts` : [`${key}-entry.ts`];
	}
	f.writeFile(path.join(pluginsRoot, "package.json"), JSON.stringify({ dependencies: { [name]: "1.0.0" } }));
	f.writeFile(path.join(pluginDir, "package.json"), JSON.stringify({ name, version: "1.0.0", veyyon: manifest }));
	return files;
}

describe("a plugin manifest entry", () => {
	for (const key of PLUGIN_MANIFEST_ENTRY_KEYS) {
		test(`declared under \`${key}\` is discovered by the loader that imports it`, async () => {
			const f = fixture(`keys-${key}`);
			const pluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
			const files = installPluginDeclaringEveryKey(f, pluginsRoot);
			f.resetCaches();

			const discovered = await CONSUMER[key](f.cwd, f.agentDir);

			expect(discovered).toContain(files[key]);
		});
	}

	test("under `commands` is a custom command sourced from the plugin", async () => {
		const f = fixture("keys-command-source");
		const pluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
		const files = installPluginDeclaringEveryKey(f, pluginsRoot);
		f.resetCaches();

		const { paths } = await discoverCustomCommands({ cwd: f.cwd, agentDir: f.agentDir });

		expect(paths).toContainEqual({ path: files.commands, source: "plugin" });
	});
});
