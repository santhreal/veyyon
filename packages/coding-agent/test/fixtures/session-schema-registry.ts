/**
 * Creates one agent session in a fresh jitless process, as the CLI runs, with every tool-enabling
 * setting on and tool discovery `all`, and prints as JSON how ArkType's global node registry grew.
 * ArkType never releases a registered node.
 *
 *   session-schema-registry.ts <scratch-dir> cold
 *     Evaluates the product's modules, creates the session, then constructs every built-in and
 *     hidden factory's tool and reads each tool's parameters once.
 *   session-schema-registry.ts <scratch-dir> prewarmed
 *     Constructs every built-in and hidden factory's tool and reads its parameters first, so every
 *     tool schema exists, then creates the session.
 */
import "../../../ai/test/fixtures/arktype-jitless";
import "./arktype-registry-baseline";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";
import { type SettingPath, Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type Tool, type ToolSession } from "../../src/tools";
import { baselineIds, registeredIds, registeredNodes, registeredSince } from "./arktype-registry-baseline";

/** What the `cold` mode prints. */
export interface ColdSessionSchemaReport {
	mode: "cold";
	/** Nodes registered by evaluating the modules a session imports. */
	builtAtImport: string[];
	/** The tools the created session holds active. */
	activeTools: string[];
	/** Every tool name the session's registry holds, active or not. */
	sessionTools: string[];
	/** Built-in and hidden factories that returned no tool with every tool-enabling setting on. */
	unbuiltFactories: string[];
	/** Factories whose tool construction, before any read of its parameters, registered a node. */
	builtByConstruction: string[];
	/** Tools whose parameters are an ArkType schema, each schema listed under the first tool read. */
	schemaTools: string[];
	/** Tools whose first read of a schema not read before registered no node: it was built earlier. */
	readWithoutBuild: string[];
}

/** What the `prewarmed` mode prints. */
export interface PrewarmedSessionSchemaReport {
	mode: "prewarmed";
	/** How many nodes creating the session registered once every tool schema existed. */
	createdNodes: number;
	/** The kind and expression of each node creating the session registered then. */
	builtAtCreate: string[];
	/** Built-in and hidden factories that returned no tool with every tool-enabling setting on. */
	unbuiltFactories: string[];
}

export type SessionSchemaReport = ColdSessionSchemaReport | PrewarmedSessionSchemaReport;

/** Every setting a built-in factory reads before it returns a tool, turned on. */
const EVERY_TOOL_ENABLED: Partial<Record<SettingPath, unknown>> = {
	"astEdit.enabled": true,
	"debug.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"lsp.tool": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"todo.enabled": true,
	"goal.enabled": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	"argot.enabled": true,
	"tools.discoveryMode": "all",
};

function isArkTypeSchema(value: unknown): boolean {
	return typeof value === "function" && typeof (value as { expression?: unknown }).expression === "string";
}

interface ConstructedTools {
	tools: Array<[string, Tool]>;
	unbuilt: string[];
	builtByConstruction: string[];
}

/** Calls every built-in and hidden factory once, recording each whose construction registered a node. */
async function constructEveryTool(toolSession: ToolSession): Promise<ConstructedTools> {
	const constructed: ConstructedTools = { tools: [], unbuilt: [], builtByConstruction: [] };
	for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
		const before = registeredIds();
		const tool = (await factory(toolSession)) as Tool | null;
		if (registeredNodes() > before.size) {
			constructed.builtByConstruction.push(`${name}: ${registeredSince(before).join(" ; ")}`);
		}
		if (tool) constructed.tools.push([name, tool]);
		else constructed.unbuilt.push(name);
	}
	constructed.unbuilt.sort();
	constructed.builtByConstruction.sort();
	return constructed;
}

try {
	const builtAtImport = registeredSince(baselineIds);
	const [scratch, mode] = process.argv.slice(2);
	if (!scratch || (mode !== "cold" && mode !== "prewarmed")) {
		throw new Error("usage: session-schema-registry.ts <scratch-dir> cold|prewarmed");
	}
	const cwd = path.join(scratch, "project");
	const agentDir = path.join(scratch, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	// `ssh` registers only with a host in the profile's `ssh.json`, `debug` only with an adapter in
	// the working directory's `dap.json`.
	fs.writeFileSync(path.join(agentDir, "ssh.json"), JSON.stringify({ hosts: { probe: { host: "127.0.0.1" } } }));
	fs.writeFileSync(
		path.join(cwd, "dap.json"),
		JSON.stringify({ adapters: { probe: { command: process.execPath, languages: ["javascript"] } } }),
	);
	const settings = await Settings.loadIsolated({ cwd, agentDir, inMemory: true, overrides: EVERY_TOOL_ENABLED });
	const toolSession: ToolSession = {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async names => names,
		getArgotSession: () => ({ loaded: false }) as never,
		agentRegistry: new AgentRegistry(),
		getAgentId: () => "Main",
	};
	const createSession = async (): Promise<AgentSession> =>
		(
			await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				model: getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			})
		).session;

	let report: SessionSchemaReport;
	let session: AgentSession;
	if (mode === "prewarmed") {
		const constructed = await constructEveryTool(toolSession);
		for (const [, tool] of constructed.tools) void tool.parameters;
		const beforeCreate = registeredIds();
		session = await createSession();
		report = {
			mode,
			createdNodes: registeredNodes() - beforeCreate.size,
			builtAtCreate: registeredSince(beforeCreate),
			unbuiltFactories: constructed.unbuilt,
		};
	} else {
		session = await createSession();
		const activeTools = session.getActiveToolNames().sort();
		const sessionTools = session.getAllToolNames().sort();
		const constructed = await constructEveryTool(toolSession);
		const readTools: Array<[string, { parameters: unknown }]> = [
			...sessionTools.map((name): [string, { parameters: unknown }] => {
				const tool = session.getToolByName(name);
				if (!tool) throw new Error(`session tool ${name} has no definition`);
				return [name, tool];
			}),
			...constructed.tools.map(([name, tool]): [string, { parameters: unknown }] => [`factory:${name}`, tool]),
		];
		const seen = new Set<unknown>();
		const schemaTools: string[] = [];
		const readWithoutBuild: string[] = [];
		for (const [name, tool] of readTools) {
			const before = registeredNodes();
			const parameters = tool.parameters;
			if (!isArkTypeSchema(parameters) || seen.has(parameters)) continue;
			seen.add(parameters);
			schemaTools.push(name);
			if (registeredNodes() === before) readWithoutBuild.push(name);
		}
		report = {
			mode,
			builtAtImport,
			activeTools,
			sessionTools,
			unbuiltFactories: constructed.unbuilt,
			builtByConstruction: constructed.builtByConstruction,
			schemaTools: schemaTools.sort(),
			readWithoutBuild: readWithoutBuild.sort(),
		};
	}
	process.stdout.write(`${JSON.stringify(report)}\n`);
	await session.dispose();
} finally {
	await postmortem.cleanup();
}
