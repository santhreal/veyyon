import { describe, expect, it } from "bun:test";
import { RpcInputDispatcher, type RpcInputFrameDeps } from "@veyyon/coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@veyyon/coding-agent/modes/rpc/rpc-types";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

const CREDENTIAL = "rpc-inline-credential-that-must-never-print  ";

describe("RPC /secret failure status", () => {
	/**
	 * The secret handler used to emit refusal prose as `command_output` and then return consumed,
	 * causing RPC to answer `success: true`. A rejected mutation must instead become the failed
	 * prompt response the protocol already defines, without duplicating or leaking command output.
	 */
	it("returns an unsuccessful RPC response for a refused secret command", async () => {
		const frames: object[] = [];
		const commandOutput: string[] = [];
		const runtime: SlashCommandRuntime = {
			session: {} as SlashCommandRuntime["session"],
			sessionManager: {} as SlashCommandRuntime["sessionManager"],
			settings: {} as SlashCommandRuntime["settings"],
			cwd: "/tmp",
			output: text => {
				commandOutput.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type !== "prompt") throw new Error(`Unexpected command ${command.type}`);
			const result = await executeAcpBuiltinSlashCommand(command.message, runtime);
			if (result === false) throw new Error("Secret command was not dispatched");
			return {
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: false },
			};
		};
		const deps: RpcInputFrameDeps = {
			handleCommand,
			output: frame => frames.push(frame as object),
			errorResponse: (id, command, message) => ({
				id,
				type: "response",
				command,
				success: false,
				error: message,
			}),
			trackBackgroundTask: () => {},
			pendingExtensionRequests: new Map(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
		};
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({
			id: "secret-refusal-1",
			type: "prompt",
			message: `/secret add RPC_TOKEN ${CREDENTIAL}`,
		});
		await dispatcher.drain();

		expect(commandOutput).toEqual([]);
		// The refusal carries the client's usage text under it, so the frame is matched by the sentence
		// it leads with rather than byte for byte: pinning the whole string would make this row a copy of
		// the help text, which is asserted where the help text lives.
		expect(frames).toEqual([
			{
				id: "secret-refusal-1",
				type: "response",
				command: "prompt",
				success: false,
				error: expect.stringContaining(
					"This client refuses an inline credential, because the line carrying it is retained in the " +
						"client's own request history. Nothing was stored. Read the value out of the environment " +
						"instead: /secret from-env MY_TOKEN <name>.",
				),
			},
		]);
		expect(JSON.stringify(frames)).not.toContain(CREDENTIAL);
		// NOR THE NAME. Both words arrived in the same tail on this surface and nothing tells them
		// apart, so the refusal repeats neither: a name echoed here is a line that may have been
		// `/secret add <credential>` with no name in it at all.
		expect(JSON.stringify(frames)).not.toContain("RPC_TOKEN");
	});
});
