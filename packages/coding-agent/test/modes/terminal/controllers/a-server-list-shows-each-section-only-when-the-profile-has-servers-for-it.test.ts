/**
 * WHY: `/mcp list` moved from `MCPCommandController` into `serverListReport`, and the report has three sections
 * whose presence the profile decides: the servers the profile's `mcp.json` declares, the servers the MCP manager
 * discovered in another tool's config, and the discovered servers the profile disabled. The defect class is a
 * section shown for a profile with nothing in it, a section dropped for a profile that has something in it, and a
 * server listed in the wrong section: a declared server repeated as disabled, a disabled server repeated as
 * discovered, and a profile whose only entries are disabled servers told it has no servers at all.
 *
 * THE INVARIANT: across every combination of declared servers, discovered servers and disabled names (a discovered
 * name, a name no config declares, and a declared name), the report lists
 *   - the declared servers under "User level";
 *   - each discovered server neither declared nor disabled under its source's provider;
 *   - each disabled name not declared under "Disabled";
 * and shows "No MCP servers configured." exactly when all three lists are empty and nothing is disabled.
 *
 * The profile's `mcp.json` is real, read by the real config reader; the MCP manager is a stub with the discovered
 * servers' sources. What this does not catch: the status glyph and the retained connection error on a row, which
 * the differential corpus in `.internal/parity-mcp-command.ts` covers.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { SourceMeta } from "@veyyon/coding-agent/discovery/capability/types";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import {
	MCPCommandController,
	type McpCommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/mcp-command-controller";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { getMCPConfigPath, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

const originalProjectDir = getProjectDir();
const dirOverrides = captureDirOverrides();

const DECLARED = ["alpha", "beta"];
const DISCOVERED: Record<string, Omit<SourceMeta, "path"> & { file: string }> = {
	"claude-one": { provider: "claude", providerName: "Claude Code", level: "user", file: ".claude.json" },
	"cursor-two": { provider: "cursor", providerName: "Cursor", level: "user", file: ".cursor/mcp.json" },
};
/** A discovered name, a name no config declares, and a declared name. */
const DISABLABLE = ["claude-one", "ghost", "alpha"];

const EMPTY = "No MCP servers configured.";

interface Profile {
	declared: string[];
	discovered: string[];
	disabled: string[];
}

/** The sections the invariant in the header expects, header first, each with its server names in order. */
function expectedSections(profile: Profile): string[][] {
	const declared = new Set(profile.declared);
	const disabled = new Set(profile.disabled);
	const discovered = profile.discovered.filter(name => !declared.has(name) && !disabled.has(name));
	const disabledShown = profile.disabled.filter(name => !declared.has(name));
	if (declared.size === 0 && discovered.length === 0 && disabled.size === 0) return [[EMPTY]];
	const sections: string[][] = [];
	if (declared.size > 0) sections.push(["User level", ...profile.declared]);
	for (const name of discovered) sections.push([DISCOVERED[name].providerName, name]);
	if (disabledShown.length > 0) sections.push(["Disabled", ...disabledShown]);
	return sections;
}

/** The report read back as sections: each header's leading word or words, then the first word of each row under it. */
function shownSections(transcript: string): string[][] {
	const lines = transcript.split("\n").map(line => line.trimEnd());
	if (lines.some(line => line.includes(EMPTY))) return [[EMPTY]];
	const sections: string[][] = [];
	let current: string[] | undefined;
	for (const line of lines) {
		const header = line.trim().match(/^(.+?) \(.*\):$/);
		if (header) {
			current = [header[1]];
			sections.push(current);
		} else if (line.trim() === "") {
			current = undefined;
		} else if (current && /^\s{2,}\S/.test(line)) {
			current.push(line.trim().split(/\s/)[0]);
		}
	}
	return sections;
}

function subsets<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let mask = 0; mask < 1 << items.length; mask++) out.push(items.filter((_, index) => mask & (1 << index)));
	return out;
}

function profiles(): Profile[] {
	const out: Profile[] = [];
	for (const declared of subsets(DECLARED)) {
		for (const discovered of subsets(Object.keys(DISCOVERED))) {
			for (const disabled of subsets(DISABLABLE)) out.push({ declared, discovered, disabled });
		}
	}
	return out;
}

async function listFor(profile: Profile, agentDir: string): Promise<string> {
	const servers: Record<string, MCPServerConfig> = {};
	for (const name of profile.declared) servers[name] = { type: "stdio", command: "true" };
	const file = getMCPConfigPath("user", getProjectDir());
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify({ mcpServers: servers, disabledServers: profile.disabled }));
	const presented: Array<{ render(width: number): readonly string[] }> = [];
	const errors: string[] = [];
	const ctx = {
		present: (component: { render(width: number): readonly string[] }) => {
			presented.push(component);
		},
		ui: { requestRender: () => {} },
		showError: (message: string) => errors.push(message),
		showStatus: () => {},
		showWarning: () => {},
		mcpManager: {
			getAllServerNames: () => [...profile.declared, ...profile.discovered],
			getSource: (name: string): SourceMeta | undefined => {
				const source = profile.discovered.includes(name) ? DISCOVERED[name] : undefined;
				return source && { ...source, path: path.join(agentDir, source.file) };
			},
			getConnectionStatus: () => "connected",
			getLastError: () => undefined,
		},
	};
	await new MCPCommandController(ctx as unknown as McpCommandControllerContext).handle("/mcp list");
	expect(errors).toEqual([]);
	return presented.map(component => stripVTControlCharacters(component.render(400).join("\n"))).join("\n");
}

describe("/mcp list shows each section only when the profile has servers for it", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-list-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-list-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		setProjectDir(originalProjectDir);
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	it("lists declared, discovered and disabled servers in their own sections across every profile", async () => {
		const all = profiles();
		for (const profile of all) {
			expect(shownSections(await listFor(profile, agentDir)), JSON.stringify(profile)).toEqual(
				expectedSections(profile),
			);
		}
		expect(all).toHaveLength(2 ** (DECLARED.length + Object.keys(DISCOVERED).length + DISABLABLE.length));
	});

	it("lists a profile whose only entries are disabled servers instead of reporting no servers", async () => {
		const shown = shownSections(await listFor({ declared: [], discovered: [], disabled: ["ghost"] }, agentDir));
		expect(shown).toEqual([["Disabled", "ghost"]]);
	});
});
