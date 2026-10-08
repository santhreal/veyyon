/**
 * An approval answer lasts only as long as the scope it was given in, and the rung a session reports
 * is the one its tools enforce.
 *
 * WHY THIS SUITE EXISTS: the session's approval state (the `--auto-approve` flag, the `/yolo`
 * bypass, the per-tool decisions an approval prompt was asked to keep, and the ACP client's
 * standing answers) is held by `SessionApprovals` in `session/runtime/session-approvals.ts`. Each
 * store has a scope: a kept tool decision ends with its conversation, a client's standing answer ends
 * with that client, and a permission prompt ends with its call. The class this suite closes is "an
 * answer that outlives, or never reaches, the scope it was given for":
 *
 * - a kept decision carried across `/new`, `/resume` or a handoff, or lost on a reload;
 * - a new ACP client that inherits the previous client's `allow_always` or `reject_always`;
 * - an explicit-yolo source that stops skipping the client prompt, or skips a tool whose own policy
 *   prompts;
 * - a rung reported without the plan-mode cap or the `--auto-approve` override;
 * - a tool gated that needs no permission, or a client that did not declare the capability asked;
 * - a pre-aborted or cancelled prompt that still runs its tool, or a relative path sent unresolved;
 * - an abort listener left on the turn signal by each gated call, which grows with the run.
 *
 * Not caught: a new conversation switch that skips the registry rescope (the switches are listed
 * here, not enumerated from source), and a client whose own `requestPermission` ignores the signal.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { getEventListeners } from "node:events";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { PERMISSION_REQUIRED_TOOLS } from "@veyyon/coding-agent/session/agent-session-permissions";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { APPROVAL_MODE_VALUES, DEFAULT_APPROVAL_MODE } from "@veyyon/coding-agent/tools/core/approval-modes";
import { TOOL } from "@veyyon/coding-agent/tools/core/builtin-names";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@veyyon/kernel/session/client-bridge";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

type FakeTool = AgentTool & { runs: number };

function fakeTool(name: string): FakeTool {
	const tool: FakeTool = {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({ "command?": "string", "path?": "string" }),
		runs: 0,
		async execute() {
			tool.runs++;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

/** A client that answers each permission request with `answer` and records what it was asked. */
function client(
	answer: () => ClientBridgePermissionOutcome | Promise<ClientBridgePermissionOutcome>,
	capable = true,
): { bridge: ClientBridge; asked: ClientBridgePermissionToolCall[] } {
	const asked: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: capable },
		async requestPermission(toolCall) {
			asked.push(toolCall);
			return await answer();
		},
	};
	return { bridge, asked };
}

const selected = (
	kind: "allow_once" | "allow_always" | "reject_once" | "reject_always",
): ClientBridgePermissionOutcome => ({
	outcome: "selected",
	optionId: kind,
	kind,
});

function run(tool: AgentTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	return tool.execute("call-1", args as never, signal, undefined as never, undefined as never);
}

describe("an approval answer", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("veyyon-approval-scope-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("veyyon-approval-scope-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		await tempDir.remove();
	});

	function build(
		options: {
			tools?: AgentTool[];
			settings?: Partial<Record<SettingPath, unknown>>;
			autoApprove?: boolean;
			sessionManager?: SessionManager;
			agentId?: string;
		} = {},
	): AgentSession {
		const tools = options.tools ?? [];
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
				convertToLlm,
			}),
			sessionManager: options.sessionManager ?? SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, ...options.settings }),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			autoApprove: options.autoApprove,
			agentId: options.agentId,
		});
		sessions.push(session);
		return session;
	}

	/** A persisted conversation, as `/resume` and a handoff need one. */
	function seededManager(text: string): SessionManager {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() - 2 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `${text} answered` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
		return manager;
	}

	/** A root session registered as `Main`, so a conversation switch re-roots it in the registry. */
	async function rootSession(): Promise<AgentSession> {
		const manager = seededManager("current");
		await manager.flush();
		const session = build({ sessionManager: manager, agentId: "Main" });
		AgentRegistry.global().register({ id: "Main", displayName: "main", kind: "main", session });
		return session;
	}

	describe("kept for a tool at an approval prompt", () => {
		const SWITCHES: Record<string, (session: AgentSession) => Promise<unknown>> = {
			"/new": session => session.newSession(),
			"/resume of another conversation": async session => {
				const other = seededManager("other");
				await other.flush();
				const file = other.getSessionFile();
				if (!file) throw new Error("expected the other conversation to have a file");
				return await session.switchSession(file);
			},
			handoff: session => {
				vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");
				return session.handoff();
			},
		};

		for (const [name, leave] of Object.entries(SWITCHES)) {
			it(`ends at ${name}`, async () => {
				const session = await rootSession();
				session.sessionToolApprovals().set("bash", "allow");
				expect(session.sessionToolApprovals().get("bash")).toBe("allow");

				await leave(session);

				expect(session.sessionToolApprovals().get("bash")).toBeUndefined();
			});
		}

		it("survives a reload of the same conversation", async () => {
			const session = await rootSession();
			session.sessionToolApprovals().set("bash", "deny");

			await session.reload();

			expect(session.sessionToolApprovals().get("bash")).toBe("deny");
		});
	});

	describe("given by an ACP client for good", () => {
		for (const kind of ["allow_always", "reject_always"] as const) {
			it(`is not asked again after ${kind}, and ${kind === "allow_always" ? "runs" : "rejects"} the call`, async () => {
				const bash = fakeTool(TOOL.bash);
				const first = client(() => selected(kind));
				const session = build({ tools: [bash] });
				session.setClientBridge(first.bridge);
				await session.setActiveToolsByName([TOOL.bash]);
				const [gated] = session.agent.state.tools;

				for (let call = 0; call < 2; call++) {
					const outcome = run(gated, { command: "echo hi" });
					if (kind === "allow_always") await outcome;
					else await expect(outcome).rejects.toThrow(/rejected by user/);
				}

				expect(first.asked).toHaveLength(1);
				expect(bash.runs).toBe(kind === "allow_always" ? 2 : 0);
			});

			it(`ends when another client connects after ${kind}`, async () => {
				const bash = fakeTool(TOOL.bash);
				const first = client(() => selected(kind));
				const second = client(() => selected("allow_once"));
				const session = build({ tools: [bash] });
				session.setClientBridge(first.bridge);
				await session.setActiveToolsByName([TOOL.bash]);
				await run(session.agent.state.tools[0], { command: "echo hi" }).catch(() => undefined);

				session.setClientBridge(second.bridge);
				await run(session.agent.state.tools[0], { command: "echo hi" });

				expect(first.asked).toHaveLength(1);
				expect(second.asked).toHaveLength(1);
			});
		}
	});

	describe("the rung a session reports", () => {
		it(`is ${DEFAULT_APPROVAL_MODE} when nothing is configured`, () => {
			expect(build().effectiveApprovalMode()).toBe(DEFAULT_APPROVAL_MODE);
		});

		for (const configured of APPROVAL_MODE_VALUES) {
			it(`is ${configured} as configured, plan under plan mode, and yolo under --auto-approve`, () => {
				const planFilePath = path.join(tempDir.path(), "plan.md");
				const plain = build({ settings: { "tools.approvalMode": configured } });
				expect(plain.effectiveApprovalMode()).toBe(configured);
				plain.setPlanModeState({ enabled: true, planFilePath });
				expect(plain.effectiveApprovalMode()).toBe("plan");

				const forced = build({ settings: { "tools.approvalMode": configured }, autoApprove: true });
				expect(forced.effectiveApprovalMode()).toBe("yolo");
				forced.setPlanModeState({ enabled: true, planFilePath });
				expect(forced.effectiveApprovalMode()).toBe("yolo");
			});
		}
	});

	describe("the ACP permission prompt", () => {
		/** Each way a session is told to run unasked, applied before the tools are activated. */
		const YOLO_SOURCES: Record<string, { autoApprove?: boolean; mode?: string; bypass?: boolean }> = {
			"--auto-approve": { autoApprove: true },
			"/yolo": { bypass: true },
			"tools.approvalMode: yolo": { mode: "yolo" },
		};

		async function gatedBash(
			source: { autoApprove?: boolean; mode?: string; bypass?: boolean },
			policy?: string,
		): Promise<{ tool: FakeTool; asked: ClientBridgePermissionToolCall[]; active: AgentTool }> {
			const tool = fakeTool(TOOL.bash);
			const { bridge, asked } = client(() => selected("allow_once"));
			const session = build({
				tools: [tool],
				autoApprove: source.autoApprove,
				settings: {
					...(source.mode ? { "tools.approvalMode": source.mode } : {}),
					...(policy ? { "tools.approval": { [TOOL.bash]: policy } } : {}),
				},
			});
			if (source.bypass) session.setApprovalBypass(true);
			session.setClientBridge(bridge);
			await session.setActiveToolsByName([TOOL.bash]);
			return { tool, asked, active: session.agent.state.tools[0] };
		}

		it("is asked with no yolo source", async () => {
			const { tool, asked, active } = await gatedBash({});
			await run(active, { command: "echo hi" });
			expect(active).not.toBe(tool);
			expect(asked).toHaveLength(1);
			expect(tool.runs).toBe(1);
		});

		for (const [name, source] of Object.entries(YOLO_SOURCES)) {
			it(`is skipped under ${name}`, async () => {
				const { tool, asked, active } = await gatedBash(source);
				await run(active, { command: "echo hi" });
				expect(active).toBe(tool);
				expect(asked).toHaveLength(0);
				expect(tool.runs).toBe(1);
			});

			it(`is still asked under ${name} for a tool whose policy prompts`, async () => {
				const { tool, asked, active } = await gatedBash(source, "prompt");
				await run(active, { command: "echo hi" });
				expect(asked).toHaveLength(1);
				expect(tool.runs).toBe(1);
			});
		}

		/**
		 * Every built-in tool name and every gated name, activated together; the tools that reach the
		 * agent as a different object than the one registered are the gated set. Pinned by exact
		 * equality, so adding a name to the permission set or wrapping every tool fails here.
		 */
		const CLIENTS: Record<string, { bridge?: () => ClientBridge; gated: string[] }> = {
			"no client": { gated: [] },
			"a client without the permission capability": {
				bridge: () => client(() => selected("allow_once"), false).bridge,
				gated: [],
			},
			"a client with the permission capability": {
				bridge: () => client(() => selected("allow_once")).bridge,
				gated: ["bash", "delete", "edit", "move"],
			},
		};
		for (const [name, { bridge, gated }] of Object.entries(CLIENTS)) {
			it(`gates ${gated.length === 0 ? "no tool" : gated.join(", ")} for ${name}`, async () => {
				const names = [...new Set([...Object.values(TOOL), ...PERMISSION_REQUIRED_TOOLS])];
				const tools = names.map(fakeTool);
				const registered = new Map(tools.map(tool => [tool.name, tool]));
				const session = build({ tools });
				if (bridge) session.setClientBridge(bridge());
				await session.setActiveToolsByName(names);

				expect(session.agent.state.tools.map(tool => tool.name).sort()).toEqual([...names].sort());
				const wrapped = session.agent.state.tools.filter(tool => tool !== registered.get(tool.name));
				expect(wrapped.map(tool => tool.name).sort()).toEqual(gated);
			});
		}

		it("does not ask, or run the tool, for a call aborted before it starts", async () => {
			const { tool, asked, active } = await gatedBash({});
			const controller = new AbortController();
			controller.abort();

			await expect(run(active, { command: "echo hi" }, controller.signal)).rejects.toThrow(
				/Permission request cancelled/,
			);
			expect(asked).toHaveLength(0);
			expect(tool.runs).toBe(0);
		});

		it("does not run the tool when the client cancels the prompt", async () => {
			const tool = fakeTool(TOOL.bash);
			const { bridge, asked } = client(() => ({ outcome: "cancelled" }));
			const session = build({ tools: [tool] });
			session.setClientBridge(bridge);
			await session.setActiveToolsByName([TOOL.bash]);

			await expect(run(session.agent.state.tools[0], { command: "echo hi" })).rejects.toThrow(
				/Permission request cancelled/,
			);
			expect(asked).toHaveLength(1);
			expect(tool.runs).toBe(0);
		});

		it("sends a relative path resolved against the session's working directory", async () => {
			const tool = fakeTool("delete");
			const { bridge, asked } = client(() => selected("allow_once"));
			const session = build({ tools: [tool] });
			session.setClientBridge(bridge);
			await session.setActiveToolsByName(["delete"]);

			await run(session.agent.state.tools[0], { path: "src/gone.ts" });

			expect(asked.map(call => call.locations)).toEqual([
				[{ path: path.join(session.sessionManager.getCwd(), "src/gone.ts") }],
			]);
		});

		/**
		 * One turn signal is shared by every tool call of the turn. Each gated call adds one abort
		 * listener while its prompt is open and must remove it when the prompt settles, whichever way
		 * it settles; a listener that stays behind costs memory for every gated call of the run.
		 */
		it("leaves no abort listener on the turn signal once each prompt settles", async () => {
			const tool = fakeTool(TOOL.bash);
			let answer = Promise.withResolvers<ClientBridgePermissionOutcome>();
			const { bridge } = client(() => answer.promise);
			const session = build({ tools: [tool] });
			session.setClientBridge(bridge);
			await session.setActiveToolsByName([TOOL.bash]);
			const signal = new AbortController().signal;

			const ANSWERS: ClientBridgePermissionOutcome[] = [
				selected("allow_once"),
				selected("reject_once"),
				{ outcome: "cancelled" },
				{ outcome: "selected", optionId: "not-an-option", kind: "allow_once" },
			];
			for (const outcome of ANSWERS) {
				answer = Promise.withResolvers<ClientBridgePermissionOutcome>();
				const call = run(session.agent.state.tools[0], { command: "echo hi" }, signal).catch(() => undefined);
				expect(getEventListeners(signal, "abort")).toHaveLength(1);
				answer.resolve(outcome);
				await call;
				expect(getEventListeners(signal, "abort")).toHaveLength(0);
			}
			expect(tool.runs).toBe(1);
		});
	});
});
