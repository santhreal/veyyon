/**
 * Regression for the headless `--print` display seam.
 *
 * Stored assistant messages keep argot handles (the token win lives in history),
 * so any surface that shows content to a person must expand them first. The
 * streamed TUI path already did; `--print` text mode read `session.state`
 * directly and leaked raw `§handle` tokens to stdout. Both paths now route
 * through {@link AgentSession.displayAssistantContent}, so this pins that method:
 * a handle in assistant content is expanded to its full text, and unloaded argot
 * is a no-op. print-mode.ts calls exactly this method before writing stdout.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { removeSyncWithRetries } from "@veyyon/utils";
import { ArgotSession, DICT_FILENAME, parseDict } from "argot";

const DICT = `
version = 1

[handles]
svc = "the checkout service"
`;

function armedArgot(): ArgotSession {
	const argot = new ArgotSession();
	argot.loadVocab(parseDict(DICT, `/repo/${DICT_FILENAME}`));
	return argot;
}

describe("AgentSession.displayAssistantContent (the --print / TUI display seam)", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-print-argot-"));
	});

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function makeSession(argot: ArgotSession | undefined): Promise<AgentSession> {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "unused-no-request-is-made",
			initialState: { model, systemPrompt: ["test"], tools },
		});
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			argot,
		});
		session.subscribe(() => {});
		return session;
	}

	const withHandle = (): AssistantMessage["content"] =>
		[{ type: "text", text: "I restarted §svc for you." }] as AssistantMessage["content"];

	it("expands a handle in assistant text to its full expansion", async () => {
		const session = await makeSession(armedArgot());
		const out = session.displayAssistantContent(withHandle());
		const block = out[0];
		expect(block.type === "text" && block.text).toBe("I restarted the checkout service for you.");
	});

	it("does not leak the raw handle marker once expanded", async () => {
		const session = await makeSession(armedArgot());
		const out = session.displayAssistantContent(withHandle());
		const block = out[0];
		expect(block.type === "text" && block.text.includes("§svc")).toBe(false);
	});

	it("is a no-op that returns the same reference when no argot is loaded", async () => {
		const session = await makeSession(undefined);
		const original = withHandle();
		expect(session.displayAssistantContent(original)).toBe(original);
	});
});
