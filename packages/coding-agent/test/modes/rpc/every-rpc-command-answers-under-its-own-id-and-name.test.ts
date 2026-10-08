/**
 * WHY THIS SUITE EXISTS.
 *
 * THE CLASS. The RPC server answers each command type through one entry of `RPC_COMMAND_HANDLERS` in
 * `modes/rpc/rpc-commands.ts`, and `handleRpcCommand` frames what the entry returns or throws. The table
 * goes wrong in three ways:
 *
 * - a command the protocol reference documents has no handler, or a handler answers a command the
 *   reference does not list, so a client reads one surface and the server answers another;
 * - a type naming an `Object.prototype` member (`constructor`, `toString`, `__proto__`) reaches that
 *   member instead of the `Unknown command` answer, because the table is an object literal;
 * - a response is framed under another request's id or command, a refusal escapes as a rejection
 *   instead of an error response, or a handler that returns nothing sends a `data` field.
 *
 * The documented types are read from the "Command Schema (canonical)" section of
 * `docs/handbook/src/reference/rpc.md`, and the prototype names from `Object.prototype`, both at run
 * time, so a new command, a dropped schema line or a new prototype member turns this suite red.
 *
 * NOT CAUGHT. What a handler does with the session: the sweep runs every handler against a session and
 * host whose every member throws, so it proves the framing and the reach of each type, not its effect.
 * Each command's behavior is covered by its own suite.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { handleRpcCommand, RPC_COMMAND_TYPES, type RpcCommandHost } from "@veyyon/coding-agent/modes/rpc/rpc-commands";
import type { RpcCommand } from "@veyyon/coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

const REFERENCE = path.join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"docs",
	"handbook",
	"src",
	"reference",
	"rpc.md",
);

/** The command types the reference's canonical schema lists, in page order. */
function documentedCommandTypes(): string[] {
	const page = fs.readFileSync(REFERENCE, "utf8");
	const start = page.indexOf("## Command Schema (canonical)");
	const end = page.indexOf("\n## ", start + 1);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return Array.from(page.slice(start, end).matchAll(/^- `\{ id\?, type: "([a-z_]+)"/gm), match => match[1]);
}

/** A stand-in whose every member read throws, so a handler that reaches it refuses. */
function unreachable<T>(name: string): T {
	return new Proxy(
		{},
		{
			get(_target, property) {
				throw new Error(`${name}.${String(property)} is out of reach`);
			},
		},
	) as T;
}

const UNREACHABLE_SESSION = unreachable<AgentSession>("session");
const UNREACHABLE_HOST = unreachable<RpcCommandHost>("host");

describe("every RPC command answers under its own id and name", () => {
	it("answers exactly the command types the protocol reference lists", () => {
		const documented = documentedCommandTypes();
		expect(documented).toContain("prompt");
		expect(documented).toContain("login");
		const handled: string[] = [...RPC_COMMAND_TYPES].sort();
		expect(handled).toEqual([...documented].sort());
	});

	it("frames each documented command's answer under the request's id and type", async () => {
		const answered = await Promise.all(
			documentedCommandTypes().map(async type => {
				const command = { id: `req-${type}`, type } as RpcCommand;
				return { type, answer: await handleRpcCommand(command, UNREACHABLE_SESSION, UNREACHABLE_HOST) };
			}),
		);
		const misframed = answered.filter(
			({ type, answer }) =>
				answer.type !== "response" ||
				answer.id !== `req-${type}` ||
				answer.command !== type ||
				(!answer.success && answer.error === `Unknown command: ${type}`),
		);
		expect(misframed).toEqual([]);
		// The stand-ins throw on every read, so a refusal here is the throw, framed rather than rejected.
		expect(answered.filter(({ answer }) => !answer.success).length).toBeGreaterThan(0);
	});

	it("answers a prototype member's name, and any other unknown type, as an unknown command without the id", async () => {
		const names = [...Object.getOwnPropertyNames(Object.prototype), "no_such_command"];
		expect(names).toEqual(expect.arrayContaining(["constructor", "toString", "__proto__", "hasOwnProperty"]));
		for (const name of names) {
			const answer = await handleRpcCommand(
				{ id: "req-unknown", type: name } as unknown as RpcCommand,
				UNREACHABLE_SESSION,
				UNREACHABLE_HOST,
			);
			expect(answer).toStrictEqual({
				id: undefined,
				type: "response",
				command: name,
				success: false,
				error: `Unknown command: ${name}`,
			});
		}
	});

	it("sends a refusal's message as the error of a response under the request's id", async () => {
		const session = { getAvailableModels: () => [] } as unknown as AgentSession;
		const answer = await handleRpcCommand(
			{ id: "req-model", type: "set_model", provider: "acme", modelId: "missing" },
			session,
			UNREACHABLE_HOST,
		);
		expect(answer).toStrictEqual({
			id: "req-model",
			type: "response",
			command: "set_model",
			success: false,
			error: "Model not found: acme/missing",
		});
	});

	it("omits data when a handler returns nothing and sends null when it returns null", async () => {
		const modes: string[] = [];
		const session = {
			setSteeringMode: (mode: string) => {
				modes.push(mode);
			},
			cycleModel: async () => undefined,
		} as unknown as AgentSession;

		const set = await handleRpcCommand(
			{ id: "req-mode", type: "set_steering_mode", mode: "all" },
			session,
			UNREACHABLE_HOST,
		);
		expect(set).toStrictEqual({ id: "req-mode", type: "response", command: "set_steering_mode", success: true });
		expect(modes).toEqual(["all"]);

		const cycled = await handleRpcCommand({ id: "req-cycle", type: "cycle_model" }, session, UNREACHABLE_HOST);
		expect(cycled).toStrictEqual({
			id: "req-cycle",
			type: "response",
			command: "cycle_model",
			success: true,
			data: null,
		});
	});
});
