/**
 * AgentSession is the final dispatcher for extension, TypeScript custom, and
 * file-backed slash commands. All three must use the canonical slash parser:
 * terminals commonly submit a Tab between the command name and its arguments,
 * and treating only a literal space as a separator turns `/name\targ` into an
 * unknown command instead of invoking `name`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@veyyon/coding-agent/extensibility/custom-commands";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";

const model = getBundledModel("openai", "gpt-4o-mini");
if (!model) throw new Error("expected bundled gpt-4o-mini");

let session: AgentSession | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
});

describe("AgentSession custom-command whitespace", () => {
	it("finds a custom command and parses its arguments when separated by a tab", async () => {
		let receivedArgs: string[] | undefined;
		const customCommands: LoadedCustomCommand[] = [
			{
				path: "tab-command.ts",
				resolvedPath: "/test/tab-command.ts",
				source: "project",
				command: {
					name: "tabbed",
					description: "Tab parsing fixture",
					execute(args) {
						receivedArgs = args;
					},
				},
			},
		];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry: {} as ModelRegistry,
			customCommands,
		});

		const forwarded = await session.prompt("/tabbed\talpha beta");

		expect(forwarded).toBe(false);
		expect(receivedArgs).toEqual(["alpha", "beta"]);
		expect(session.messages).toHaveLength(0);
	});
});
