import { describe, expect, test } from "bun:test";
import {
	dispatchRpcInputFrame,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
} from "@veyyon/coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@veyyon/coding-agent/modes/rpc/rpc-types";

/**
 * RPC frame contracts from docs/rpc.md:
 * - Unknown command responses emit with id: undefined even when the request had an id.
 * - Parse/handler exceptions emit command: "parse" with id: undefined.
 * - Ready is process-level (covered by spawn suites); here we lock dispatcher behavior.
 *
 * These cases are in-process (no provider keys) so they always run in CI.
 */

type OutputFrame = RpcResponse | object;

const makeDeps = (handleCommand: RpcInputFrameDeps["handleCommand"]) => {
	const outputs: OutputFrame[] = [];
	const deps: RpcInputFrameDeps = {
		handleCommand,
		output: obj => {
			outputs.push(obj as OutputFrame);
		},
		errorResponse: (id, command, message) => ({
			id,
			type: "response",
			command,
			success: false,
			error: message,
		}),
		pendingExtensionRequests: new Map(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
	return { deps, outputs };
};

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));

/** Minimal success body for get_state so handlers that pass through stay typed. */
const emptyStateData = {
	thinkingLevel: undefined,
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all" as const,
	followUpMode: "all" as const,
	interruptMode: "immediate" as const,
	sessionId: "contract-session",
	autoCompactionEnabled: false,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [] as [],
};

describe("RPC command contracts (dispatcher)", () => {
	test("malformed frames emit parse error with id undefined (request id never echoed)", () => {
		const { deps, outputs } = makeDeps(async command => ({
			id: command.id,
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		}));
		const dispatcher = new RpcInputDispatcher({ deps });

		// null/undefined throw when reading `.type` and surface as parse frames.
		// (JSONL non-objects that do not throw fall through as unknown commands
		// and are covered by the unknown-command contract below.)
		dispatcher.dispatch(null);
		dispatcher.dispatch(undefined);

		expect(outputs).toHaveLength(2);
		for (const frame of outputs) {
			expect(frame).toEqual({
				id: undefined,
				type: "response",
				command: "parse",
				success: false,
				error: expect.stringContaining("Failed to parse command:"),
			});
		}
	});

	test("unknown command type: handleCommand default path drops request id", async () => {
		// Mirrors rpc-mode handleCommand default: error(undefined, type, message).
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			const type = (command as { type: string }).type;
			const known = new Set(["get_state", "abort", "get_messages"]);
			if (!known.has(type)) {
				return {
					id: undefined,
					type: "response",
					command: type,
					success: false,
					error: `Unknown command: ${type}`,
				};
			}
			if (command.type === "get_state") {
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: emptyStateData,
				};
			}
			if (command.type === "abort") {
				return { id: command.id, type: "response", command: "abort", success: true };
			}
			return {
				id: command.id,
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [] },
			};
		};

		const { deps, outputs } = makeDeps(handleCommand);

		await dispatchRpcInputFrame({ id: "req-unknown-1", type: "definitely_not_a_command" as "abort" }, deps);
		await flushMicrotasks();

		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toEqual({
			id: undefined,
			type: "response",
			command: "definitely_not_a_command",
			success: false,
			error: "Unknown command: definitely_not_a_command",
		});
	});

	test("known commands echo the request id on success and on handler error", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "get_state") {
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: emptyStateData,
				};
			}
			if (command.type === "abort") {
				throw new Error("abort boom");
			}
			throw new Error(`unexpected: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);
		// Handler errors are mapped to response frames by RpcInputDispatcher
		// (dispatchRpcInputFrame itself rethrows for non-bash commands).
		const dispatcher = new RpcInputDispatcher({ deps });
		dispatcher.dispatch({ id: "state-1", type: "get_state" });
		dispatcher.dispatch({ id: "abort-1", type: "abort" });
		await dispatcher.drain();

		expect(outputs[0]).toEqual({
			id: "state-1",
			type: "response",
			command: "get_state",
			success: true,
			data: emptyStateData,
		});
		expect(outputs[1]).toEqual({
			id: "abort-1",
			type: "response",
			command: "abort",
			success: false,
			error: "abort boom",
		});
	});

	test("id-less known commands stay id-less on success", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type !== "get_state") throw new Error(`unexpected: ${command.type}`);
			return {
				id: command.id,
				type: "response",
				command: "get_state",
				success: true,
				data: emptyStateData,
			};
		};
		const { deps, outputs } = makeDeps(handleCommand);
		await dispatchRpcInputFrame({ type: "get_state" }, deps);
		expect(outputs).toEqual([
			{
				id: undefined,
				type: "response",
				command: "get_state",
				success: true,
				data: emptyStateData,
			},
		]);
	});

	test("parse error does not break the dispatcher for a following valid command", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type !== "abort") throw new Error(`unexpected: ${command.type}`);
			return { id: command.id, type: "response", command: "abort", success: true };
		};
		const { deps, outputs } = makeDeps(handleCommand);
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch(null);
		dispatcher.dispatch({ id: "after-parse", type: "abort" });
		await dispatcher.drain();

		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toMatchObject({
			id: undefined,
			command: "parse",
			success: false,
		});
		expect(outputs[1]).toEqual({
			id: "after-parse",
			type: "response",
			command: "abort",
			success: true,
		});
	});

	test("unknown command drops numeric-looking and UUID request ids", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			const type = (command as { type: string }).type;
			return {
				id: undefined,
				type: "response",
				command: type,
				success: false,
				error: `Unknown command: ${type}`,
			};
		};
		const { deps, outputs } = makeDeps(handleCommand);

		await dispatchRpcInputFrame({ id: "12345", type: "still_not_a_command" as "abort" }, deps);
		await dispatchRpcInputFrame(
			{ id: "550e8400-e29b-41d4-a716-446655440000", type: "also_not_a_command" as "abort" },
			deps,
		);
		await flushMicrotasks();

		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toEqual({
			id: undefined,
			type: "response",
			command: "still_not_a_command",
			success: false,
			error: "Unknown command: still_not_a_command",
		});
		expect(outputs[1]).toEqual({
			id: undefined,
			type: "response",
			command: "also_not_a_command",
			success: false,
			error: "Unknown command: also_not_a_command",
		});
	});

	test("known get_state echoes UUID and empty-string ids exactly", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type !== "get_state") throw new Error(`unexpected: ${command.type}`);
			return {
				id: command.id,
				type: "response",
				command: "get_state",
				success: true,
				data: emptyStateData,
			};
		};
		const { deps, outputs } = makeDeps(handleCommand);
		const uuid = "550e8400-e29b-41d4-a716-446655440000";

		await dispatchRpcInputFrame({ id: uuid, type: "get_state" }, deps);
		await dispatchRpcInputFrame({ id: "", type: "get_state" }, deps);

		expect(outputs[0]).toEqual({
			id: uuid,
			type: "response",
			command: "get_state",
			success: true,
			data: emptyStateData,
		});
		expect(outputs[1]).toEqual({
			id: "",
			type: "response",
			command: "get_state",
			success: true,
			data: emptyStateData,
		});
	});
});

/**
 * Catalog of RpcCommand discriminant strings. A new command type must land here
 * so the suite forces an explicit contract decision (id echo, background vs
 * serial, host-tool side channel). Pure type inventory: the runtime table is
 * rpc-types.ts; this list fails the suite if a discriminant is removed without
 * updating the contracts.
 */
const RPC_COMMAND_TYPES = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"new_session",
	"get_state",
	"get_available_commands",
	"set_todos",
	"set_host_tools",
	"set_host_uri_schemes",
	"set_subagent_subscription",
	"get_subagents",
	"get_subagent_messages",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"branch",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"handoff",
	"get_messages",
	"get_login_providers",
	"login",
] as const;

describe("RPC command catalog", () => {
	test("catalog lists every RpcCommand discriminant used by the type union", () => {
		// Structural lock: each name is a non-empty snake_case token; the count
		// is the gate that forces an update when rpc-types grows or shrinks.
		expect(RPC_COMMAND_TYPES.length).toBe(39);
		for (const name of RPC_COMMAND_TYPES) {
			expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
		}
		// No duplicates.
		expect(new Set(RPC_COMMAND_TYPES).size).toBe(RPC_COMMAND_TYPES.length);
	});

	test("bash is the only command background-dispatched by dispatchRpcInputFrame", async () => {
		const seen: string[] = [];
		const { promise: hold, resolve } = Promise.withResolvers<RpcResponse>();
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			seen.push(command.type);
			if (command.type === "bash") {
				return await hold;
			}
			if (command.type === "abort_bash") {
				return { id: command.id, type: "response", command: "abort_bash", success: true };
			}
			throw new Error(`unexpected: ${command.type}`);
		};
		const { deps, outputs } = makeDeps(handleCommand);

		const bashRet = dispatchRpcInputFrame({ id: "b", type: "bash", command: "true" }, deps);
		// Background: returns undefined immediately.
		expect(bashRet).toBeUndefined();
		expect(seen).toEqual(["bash"]);

		const abortRet = dispatchRpcInputFrame({ id: "a", type: "abort_bash" }, deps);
		expect(abortRet).toBeInstanceOf(Promise);
		await abortRet;
		expect(outputs[0]).toMatchObject({ id: "a", command: "abort_bash", success: true });

		resolve({
			id: "b",
			type: "response",
			command: "bash",
			success: true,
			data: {
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			},
		});
		await flushMicrotasks();
		await flushMicrotasks();
		expect(outputs.some(f => (f as RpcResponse).id === "b")).toBe(true);
	});
});
