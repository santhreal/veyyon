/**
 * The tool block's size, per tool and in total, measured on the REAL boot.
 *
 * WHY THIS EXISTS. Every active tool's description and rendered examples ship on every single
 * request, and nothing was counting them. The number reached 54 kB of prose across 19 tools
 * before anyone looked, which is roughly 13.6k tokens of fixed cost per turn, and it grew one
 * well-meaning paragraph at a time because a paragraph is invisible and the total is not
 * printed anywhere.
 *
 * WHAT IT DEFENDS, and the class it closes. Not "the tools got smaller once": that is a
 * commit, not a contract. The contract is that the size of the model's tool surface is a
 * RECORDED decision per tool, in both directions:
 *
 *  - Over its ceiling → RED. A description cannot grow past what someone wrote down.
 *  - {@link CEILING_SLACK} under its ceiling → RED, tighten the row. A ceiling nobody lowers
 *    after a prune stops describing anything and the gate quietly permits regrowth back up to
 *    a number that was never justified.
 *  - Active tool with NO row → RED. A new tool cannot arrive with an unmeasured description,
 *    which is the failure mode a hardcoded list of "tools we care about" would have.
 *  - Row for a tool that is not active → RED. A stale row is a decision about nothing.
 *
 * The active set is read from the running session rather than from `BUILTIN_TOOL_NAMES`,
 * because what costs tokens is what `createAgentSession` actually constructs and hands the
 * provider, not what the registry could build.
 *
 * WHAT IT DOES NOT CATCH. Nothing here says a description still TEACHES. Bytes are not
 * comprehension: a prune that deletes the selector grammar passes this gate and breaks the
 * product. The benches are what answer that (`packages/typescript-edit-benchmark` for the
 * edit/read/grep surface, `packages/deepswe-bench` end to end), and they are the required
 * companion to any cut made here. This gate also says nothing about JSON schema bytes, which
 * are structural (field names, enum literals) and not prose to be shortened.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderToolExamples } from "@veyyon/ai/dialect/examples";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { BASE_SETTINGS, HOST_DEPENDENT_TOOL_NAMES } from "./tool-loading-differential.harness";

/**
 * Bytes of `description` + rendered `<examples>` each active tool may ship.
 *
 * Recorded, not derived: every row is a number someone chose to pay. Lower a row when you prune
 * that tool; the gate tells you when a row has gone slack. `examples` are counted with the
 * description because they are appended to it on the wire — a tool that moves prose into an
 * example array has not saved anything.
 */
const TOOL_PROMPT_CEILINGS: Record<string, number> = {
	edit: 8030,
	eval: 5610,
	read: 4180,
	bash: 3910,
	todo: 3800,
	irc: 3450,
	launch: 2820,
	task: 2720,
	debug: 2350,
	ast_grep: 2140,
	ast_edit: 2120,
	job: 1700,
	set_cwd: 1690,
	glob: 1600,
	grep: 900,
	write: 700,
	resolve: 480,
	web_search: 340,
};

/** Total the whole active set may ship, description + examples. */
const TOTAL_PROMPT_CEILING = 48_000;

/**
 * How far under its ceiling a tool may sit before the row is stale.
 *
 * Wide enough that a one-sentence edit does not fail the suite, narrow enough that a real
 * prune has to be recorded. A prune is exactly when the number should move, so needing to
 * edit the row is the point, not friction.
 */
const CEILING_SLACK = 400;

interface ToolPromptSize {
	name: string;
	bytes: number;
}

describe("the tool block's size is a recorded decision", () => {
	useIsolatedAgentDir();
	let sizes: ToolPromptSize[] = [];
	let tempDir = "";

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `tool-prompt-budget-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const authStorage = await isolatedAuthStorage(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ ...BASE_SETTINGS }),
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			sizes = session.agent.state.tools
				.filter(tool => !HOST_DEPENDENT_TOOL_NAMES[tool.name])
				.map(tool => ({
					name: tool.name,
					bytes: (tool.description ?? "").length + renderToolExamples(tool, "xml", "i").length,
				}));
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	afterAll(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
	});

	it("boots a tool set worth measuring", () => {
		// A boot that produced two tools would make every assertion below vacuously true.
		expect(sizes.length).toBeGreaterThanOrEqual(15);
	});

	it("records a ceiling for every active tool", () => {
		const undecided = sizes.filter(size => TOOL_PROMPT_CEILINGS[size.name] === undefined);
		expect(undecided.map(size => `${size.name} ships ${size.bytes} bytes with no recorded ceiling`)).toEqual([]);
	});

	it("keeps no ceiling for a tool the boot does not offer", () => {
		const active = new Set(sizes.map(size => size.name));
		expect(Object.keys(TOOL_PROMPT_CEILINGS).filter(name => !active.has(name))).toEqual([]);
	});

	it("keeps every tool inside its ceiling", () => {
		const over = sizes
			.filter(size => size.bytes > (TOOL_PROMPT_CEILINGS[size.name] ?? 0))
			.map(size => `${size.name}: ${size.bytes} > ${TOOL_PROMPT_CEILINGS[size.name]}`);
		expect(over).toEqual([]);
	});

	it("keeps no ceiling that has gone slack", () => {
		const slack = sizes
			.filter(size => {
				const ceiling = TOOL_PROMPT_CEILINGS[size.name];
				return ceiling !== undefined && size.bytes < ceiling - CEILING_SLACK;
			})
			.map(size => `${size.name}: ${size.bytes} bytes, ceiling ${TOOL_PROMPT_CEILINGS[size.name]} — lower it`);
		expect(slack).toEqual([]);
	});

	it("keeps the whole tool block inside its total", () => {
		const total = sizes.reduce((sum, size) => sum + size.bytes, 0);
		expect(total).toBeLessThanOrEqual(TOTAL_PROMPT_CEILING);
	});
});
