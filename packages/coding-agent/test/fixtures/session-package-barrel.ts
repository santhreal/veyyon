/**
 * Creates one agent session in a fresh process and prints, as JSON: whether the package barrel
 * (`src/index.ts`) was evaluated, the Zod modules evaluated once the session exists and again once
 * every active tool's parameters are converted to the wire schema a request sends, the active tool
 * names, the slash commands the session's extensions registered, and the types of
 * `api.pi.createAgentSession` and `api.zod.object` as an author's inline extension received them.
 * Then it calls every built-in and hidden tool factory with every tool-enabling setting on, converts
 * each tool it gets to the wire schema, and prints the Zod modules evaluated after that and the
 * factories that returned no tool.
 * argv[2] is the scratch directory; argv[3] is `author` to pass one author inline extension.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";
import { Settings } from "../../src/config/settings";
import type { ExtensionFactory } from "../../src/extensibility/extensions";
import { createAgentSession } from "../../src/sdk";
import { visitEveryFirstPartyTool } from "../helpers/every-first-party-tool";

const PACKAGE_BARREL = path.join("packages", "coding-agent", "src", "index.ts");
const ZOD_MODULE = `${path.sep}node_modules${path.sep}zod${path.sep}`;

function zodModules(): string[] {
	return Object.keys(require.cache).filter(file => path.normalize(file).includes(ZOD_MODULE));
}

try {
	const scratch = process.argv[2];
	if (!scratch) throw new Error("usage: session-package-barrel.ts <scratch-dir> [author]");
	const cwd = path.join(scratch, "project");
	fs.mkdirSync(cwd, { recursive: true });
	let authorPi: string | null = null;
	let authorZod: string | null = null;
	const author: ExtensionFactory = api => {
		authorPi = typeof api.pi.createAgentSession;
		authorZod = typeof api.zod.object;
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(scratch, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		model: getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5"),
		extensions: process.argv[3] === "author" ? [author] : undefined,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	const barrelLoaded = Object.keys(require.cache).some(file => path.normalize(file).endsWith(PACKAGE_BARREL));
	const zodAtCreate = zodModules();
	const tools = session.getActiveToolNames().sort();
	for (const name of tools) {
		const tool = session.getToolByName(name);
		if (!tool) throw new Error(`active tool ${name} has no definition`);
		toolWireSchema(tool);
	}
	const zodAtWire = zodModules();
	const commands = (session.extensionRunner?.getRegisteredCommands() ?? []).map(command => command.name).sort();
	const unbuiltFactories = await visitEveryFirstPartyTool(path.join(scratch, "sweep"), tool => {
		toolWireSchema(tool);
	});
	const zodAtEveryTool = zodModules();
	process.stdout.write(
		`${JSON.stringify({ barrelLoaded, zodAtCreate, zodAtWire, zodAtEveryTool, unbuiltFactories, tools, commands, authorPi, authorZod })}\n`,
	);
	await session.dispose();
} finally {
	await postmortem.cleanup();
}
