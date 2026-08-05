/**
 * An MCP config that cannot be parsed is reported, not swallowed.
 *
 * THE BUG. `loadAllMCPConfigs` called `loadCapability("mcps", ...)` and read only
 * `result.items` off the answer, discarding `result.warnings`. The provider pushes
 * `Failed to parse JSON in <path>` when the file is not valid JSON, and the capability
 * layer pushes `Invalid item at <path>: ...` for an entry that names neither a command
 * nor a url. Both were produced, both were dropped one frame later, and the shape of the
 * loss is the worst one available: a config the loader could not read yields NO server
 * name, so the per-server failure path in `connectServers` has nothing to report against
 * either. The operator edited `mcp.json`, mistyped a comma, and got a session that booted
 * clean with every configured MCP server missing and no line anywhere saying why.
 *
 * WHICH FILE. Originally the project root's `.mcp.json`, because the `mcp-json` provider
 * was the only one that raised the parse warning at all. That provider is gone: a
 * repository does not name the MCP servers an agent connects to, so nothing in a working
 * tree is loaded and nothing there can be unparseable. The file the operator actually
 * edits is the profile-scoped `<agentDir>/mcp.json`, and the `native` provider used to
 * drop a parse failure there on the floor. Deleting the project provider would have left
 * the warning with no source at all. The report now comes from `native`, so it covers the
 * scope that survived.
 *
 * WHAT THIS LOCKS. The warnings reach `MCPManager.discoverAndConnect`'s `onStatus`
 * channel as `failed` events, which is the same channel a refused server config already
 * uses and what the boot health zone and `/mcp list` render.
 *
 * THE INPUT IS REAL. A genuinely malformed file is written to a temp profile and read
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
import { MCP_CONFIG_STATUS_LABEL, type McpConnectionStatusEvent } from "@veyyon/coding-agent/mcp/startup-events";
import { removeWithRetries, setAgentDir } from "@veyyon/utils";
import { APP_DISPLAY_NAME } from "@veyyon/utils/app-identity";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/** The capability layer prefixes every warning with the reporting provider's display name. */
const NATIVE = `[${APP_DISPLAY_NAME}]`;

describe("an unreadable MCP config is reported instead of vanishing", () => {
	let settingsState: SettingsTestState | undefined;
	let tempHome = "";
	let agentDir = "";
	let projectDir = "";
	const dirOverrides = captureDirOverrides();

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-broken-home-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-broken-agent-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-broken-project-"));
		// An isolated home and profile so the developer's own MCP servers are not
		// discovered, connected to, or counted in the assertions below.
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(agentDir);
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(tempHome);
		await removeWithRetries(agentDir);
		await removeWithRetries(projectDir);
	});

	/**
	 * The loader hands the parse failure back instead of returning an empty,
	 * successful-looking config set.
	 */
	it("carries a profile-scoped parse failure out of loadAllMCPConfigs", async () => {
		// A real syntax error: a trailing comma before the closing brace.
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			'{\n  "mcpServers": {\n    "notes": { "command": "notes-server" },\n  }\n}\n',
		);

		const result = await loadAllMCPConfigs(projectDir);

		// The server the operator configured really is gone: that half is not the bug.
		expect(Object.keys(result.configs)).toEqual([]);
		// The reason is not.
		expect(result.warnings).toContain(`${NATIVE} Failed to parse JSON in ${path.join(agentDir, "mcp.json")}`);
	});

	/**
	 * The operator-facing end: `discoverAndConnect` puts the same failure on the status
	 * channel, under the config label, so the boot health zone has something to show.
	 *
	 * Emitted AFTER `connectServers` on purpose, because its `connecting` event resets the
	 * subscriber's failed-server map, so a warning raised first would be wiped before
	 * anything rendered it. A `connecting` event arriving after the failure would prove
	 * the ordering regressed.
	 */
	it("emits the failure on the status channel discoverAndConnect already uses", async () => {
		await fs.writeFile(path.join(agentDir, "mcp.json"), '{ "mcpServers": { "notes": }}\n');
		const expected = `${NATIVE} Failed to parse JSON in ${path.join(agentDir, "mcp.json")}`;

		const manager = new MCPManager(projectDir);
		const events: McpConnectionStatusEvent[] = [];
		try {
			await manager.discoverAndConnect({ onStatus: event => events.push(event) });
		} finally {
			await manager.disconnectAll();
		}

		const failures = events.filter(event => event.type === "failed");
		expect(failures).toEqual([{ type: "failed", serverName: MCP_CONFIG_STATUS_LABEL, error: expected }]);
		// Nothing may reset the failure after it is raised.
		expect(events.at(-1)).toEqual(failures[0]);
		// And the manager remembers it, which is what `/mcp list` reads.
		expect(manager.getLastError(MCP_CONFIG_STATUS_LABEL)).toBe(expected);
	});

	/**
	 * The other half of the same swallow: a syntactically valid file whose entry the
	 * capability layer refuses. The server never becomes a config, so `connectServers`
	 * cannot speak for it either, and before the fix this was silent too.
	 */
	it("reports an entry the capability layer refuses", async () => {
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			'{ "mcpServers": { "notes": { "env": { "TOKEN": "x" } } } }\n',
		);

		const result = await loadAllMCPConfigs(projectDir);

		expect(Object.keys(result.configs)).toEqual([]);
		expect(result.warnings).toContain(
			`${NATIVE} Invalid item at ${path.join(agentDir, "mcp.json")}: Must have command or url`,
		);
	});

	/**
	 * The inversion. A broken `.mcp.json` in the working tree used to be REPORTED,
	 * because the working tree used to be read. It is now ignored end to end: no
	 * config, no warning, and no status event naming it. Silence is the correct
	 * answer here and only here: the operator did not write this file and cannot be
	 * asked to fix it, and a warning per hostile repo would be a nuisance channel.
	 *
	 * Re-registering the deleted `mcp-json` provider turns every expectation below
	 * red, which is the point: this case fails the moment project discovery returns.
	 */
	it("says nothing about an unreadable .mcp.json in the working tree, because it never reads one", async () => {
		const repoConfig = path.join(projectDir, ".mcp.json");
		await fs.writeFile(repoConfig, '{ "mcpServers": { "notes": }}\n');
		await fs.writeFile(
			path.join(projectDir, "mcp.json"),
			'{ "mcpServers": { "root-notes": { "command": "notes-server" } } }\n',
		);

		const result = await loadAllMCPConfigs(projectDir);

		expect(Object.keys(result.configs)).toEqual([]);
		expect(result.warnings.filter(warning => warning.includes(projectDir))).toEqual([]);

		const manager = new MCPManager(projectDir);
		const events: McpConnectionStatusEvent[] = [];
		try {
			await manager.discoverAndConnect({ onStatus: event => events.push(event) });
		} finally {
			await manager.disconnectAll();
		}
		expect(events).toEqual([]);
		expect(manager.getLastError(MCP_CONFIG_STATUS_LABEL)).toBeUndefined();
	});
});
