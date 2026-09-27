/**
 * Creates one agent session in a fresh process and prints, as JSON: whether the package barrel
 * (`src/index.ts`) was evaluated, the slash commands the session's extensions registered, and the
 * type of `api.pi.createAgentSession` as an author's inline extension received it. argv[2] is the
 * scratch directory; argv[3] is `author` to pass one author inline extension.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";
import { Settings } from "../../src/config/settings";
import type { ExtensionFactory } from "../../src/extensibility/extensions";
import { createAgentSession } from "../../src/sdk";

const PACKAGE_BARREL = path.join("packages", "coding-agent", "src", "index.ts");

try {
	const scratch = process.argv[2];
	if (!scratch) throw new Error("usage: session-package-barrel.ts <scratch-dir> [author]");
	const cwd = path.join(scratch, "project");
	fs.mkdirSync(cwd, { recursive: true });
	let authorPi: string | null = null;
	const author: ExtensionFactory = api => {
		authorPi = typeof api.pi.createAgentSession;
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
	const commands = (session.extensionRunner?.getRegisteredCommands() ?? []).map(command => command.name).sort();
	process.stdout.write(`${JSON.stringify({ barrelLoaded, commands, authorPi })}\n`);
	await session.dispose();
} finally {
	await postmortem.cleanup();
}
