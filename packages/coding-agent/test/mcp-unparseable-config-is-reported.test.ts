/**
 * An `.mcp.json` that cannot be parsed is reported, not swallowed.
 *
 * THE BUG. `loadAllMCPConfigs` called `loadCapability("mcps", ...)` and read only
 * `result.items` off the answer, discarding `result.warnings`. The mcp-json provider
 * pushes `Failed to parse JSON in <path>` when the file is not valid JSON, and the
 * capability layer pushes `Invalid item at <path>: ...` for an entry that names neither
 * a command nor a url. Both were produced, both were dropped one frame later, and the
 * shape of the loss is the worst one available: a config the loader could not read
 * yields NO server name, so the per-server failure path in `connectServers` has nothing
 * to report against either. The user edited `.mcp.json`, mistyped a comma, and got a
 * session that booted clean with every configured MCP server missing and no line
 * anywhere saying why.
 *
 * WHAT THIS LOCKS. The warnings reach `MCPManager.discoverAndConnect`'s `onStatus`
 * channel as `failed` events, which is the same channel a refused server config already
 * uses and what the boot health zone and `/mcp list` render.
 *
 * THE INPUT IS REAL. A genuinely malformed file is written to a temp project and read
 * through the live capability providers. Nothing is stubbed, and no error object is
 * hand-constructed: the message under assertion is the one the JSON parse actually
 * produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@veyyon/coding-agent/mcp/config";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@veyyon/coding-agent/mcp/startup-events";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("an unreadable MCP config is reported instead of vanishing", () => {
	let settingsState: SettingsTestState | undefined;
	let tempHome = "";
	let projectDir = "";

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-broken-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-broken-project-"));
		// An isolated home so the developer's own ~/.veyyon MCP servers are not
		// discovered, connected to, or counted in the assertions below.
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
	});

	/**
	 * The loader hands the parse failure back instead of returning an empty,
	 * successful-looking config set.
	 */
	it("carries the parse failure out of loadAllMCPConfigs", async () => {
		// A real syntax error: a trailing comma before the closing brace.
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			'{\n  "mcpServers": {\n    "notes": { "command": "notes-server" },\n  }\n}\n',
		);

		const result = await loadAllMCPConfigs(projectDir);

		// The server the user configured really is gone: that half is not the bug.
		expect(Object.keys(result.configs)).toEqual([]);
		// The reason is not.
		expect(result.warnings).toContain(`[MCP Config] Failed to parse JSON in ${path.join(projectDir, ".mcp.json")}`);
	});

	/**
	 * The operator-facing end: `discoverAndConnect` puts the same failure on the status
	 * channel, under the config label, so the boot health zone has something to show.
	 *
	 * Emitted AFTER `connectServers` on purpose — its `connecting` event resets the
	 * subscriber's failed-server map, so a warning raised first would be wiped before
	 * anything rendered it. A `connecting` event arriving after the failure would prove
	 * the ordering regressed.
	 */
	it("emits the failure on the status channel discoverAndConnect already uses", async () => {
		await fs.writeFile(path.join(projectDir, ".mcp.json"), '{ "mcpServers": { "notes": }}\n');

		const manager = new MCPManager(projectDir);
		const events: McpConnectionStatusEvent[] = [];
		try {
			await manager.discoverAndConnect({ onStatus: event => events.push(event) });
		} finally {
			await manager.disconnectAll();
		}

		const failures = events.filter(event => event.type === "failed");
		expect(failures).toEqual([
			{
				type: "failed",
				serverName: ".mcp.json",
				error: `[MCP Config] Failed to parse JSON in ${path.join(projectDir, ".mcp.json")}`,
			},
		]);
		// Nothing may reset the failure after it is raised.
		expect(events.at(-1)).toEqual(failures[0]);
		// And the manager remembers it, which is what `/mcp list` reads.
		expect(manager.getLastError(".mcp.json")).toBe(
			`[MCP Config] Failed to parse JSON in ${path.join(projectDir, ".mcp.json")}`,
		);
	});

	/**
	 * The other half of the same swallow: a syntactically valid file whose entry the
	 * capability layer refuses. The server never becomes a config, so `connectServers`
	 * cannot speak for it either, and before the fix this was silent too.
	 */
	it("reports an entry the capability layer refuses", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			'{ "mcpServers": { "notes": { "env": { "TOKEN": "x" } } } }\n',
		);

		const result = await loadAllMCPConfigs(projectDir);

		expect(Object.keys(result.configs)).toEqual([]);
		expect(result.warnings).toContain(
			`[MCP Config] Invalid item at ${path.join(projectDir, ".mcp.json")}: Must have command or url`,
		);
	});
});
