/**
 * The approval state a session enforces: the CLI auto-approve flag, the `/yolo` bypass, the parent's
 * live bypass for a spawned agent, the per-tool decisions an approval prompt was asked to keep, and
 * the ACP client permission proxy with its own standing decisions.
 *
 * This is a session collaborator. The session reads its connected client bridge, its working
 * directory and whether plan mode is on through {@link SessionApprovalsHost}; every decision store
 * here is session-scoped and never written to settings.
 */
import type { AgentTool } from "@veyyon/agent-core";
import type { ClientBridge, ClientBridgePermissionOutcome } from "@veyyon/kernel/session/client-bridge";
import { getStringProperty, isRecord } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import { resolveEffectiveApprovalMode } from "../../tools/core/approval";
import type { ApprovalMode, SessionToolApprovals } from "../../tools/core/approval-modes";
import { TOOL } from "../../tools/core/builtin-names";
import { ToolAbortError, ToolError } from "../../tools/core/tool-errors";
import {
	extractPermissionLocations,
	getPermissionIntent,
	PERMISSION_OPTIONS,
	PERMISSION_OPTIONS_BY_ID,
	PERMISSION_REQUIRED_TOOLS,
} from "../agent-session-permissions";

/** What {@link SessionApprovals} needs from the session that holds it. */
export interface SessionApprovalsHost {
	/** Read on every call, so a settings change applies to the next tool call. */
	readonly settings: Pick<Settings, "get" | "isConfigured">;
	/** The connected ACP client, read when a tool is wrapped. */
	clientBridge(): ClientBridge | undefined;
	/** The working directory permission locations are resolved against. */
	cwd(): string;
	/** Whether an active plan session caps the rung to `plan`. */
	planModeActive(): boolean;
}

/** The approval options a session is created with. */
export interface SessionApprovalsOptions {
	/** `--yolo` / `--auto-approve`: forces `yolo` for the whole run. */
	readonly autoApprove?: boolean;
	/** Start with the `/yolo` bypass on, as a spawned agent of a bypassed parent does. */
	readonly bypassAllApprovals?: boolean;
	/** The parent session's live bypass state, for a spawned agent. */
	readonly parentApprovalBypassed?: () => boolean;
}

type ClientDecision = "allow_always" | "reject_always";

type PermissionRaceResult = { kind: "permission"; outcome: ClientBridgePermissionOutcome } | { kind: "aborted" };

export class SessionApprovals {
	readonly #host: SessionApprovalsHost;
	readonly #autoApprove: boolean;
	/**
	 * The `/yolo` bypass. Defaults off and is never persisted: every approval that would prompt is
	 * allowed while set, but an explicit `deny` and a plan-mode block still stop the call. Read live
	 * into each tool-execution context, so a toggle applies to the next tool call.
	 */
	#bypassActive: boolean;
	/**
	 * The parent session's live bypass state. Undefined in a root session. Read on every
	 * {@link isBypassed} call, so `/yolo off` in the parent reaches a spawned agent that is running.
	 */
	readonly #parentBypassed: (() => boolean) | undefined;
	/**
	 * Per-tool decisions answered "Always allow" / "Always deny" at an interactive approval prompt.
	 * A grant written to `tools.approval` would outlive the task it was granted for; this one ends
	 * with the conversation, so the next launch prompts again.
	 */
	readonly #toolDecisions = new Map<string, "allow" | "deny">();
	/** `allow_always` / `reject_always` answers from the connected ACP client, per permission intent. */
	readonly #clientDecisions = new Map<string, ClientDecision>();

	constructor(host: SessionApprovalsHost, options: SessionApprovalsOptions) {
		this.#host = host;
		this.#autoApprove = options.autoApprove === true;
		this.#bypassActive = options.bypassAllApprovals === true;
		this.#parentBypassed = options.parentApprovalBypassed;
	}

	/**
	 * The approval rung the session enforces, which is not always the one stored in
	 * `tools.approvalMode`: `--yolo` / `--auto-approve` forces `yolo` for the whole run, and an active
	 * plan session caps to `plan`. A surface that shows the rung reads this, through the same
	 * resolution the tool wrapper performs, so the label and the behaviour agree.
	 */
	effectiveMode(): ApprovalMode {
		return resolveEffectiveApprovalMode(this.#host.settings.get("tools.approvalMode"), {
			planModeActive: this.#host.planModeActive(),
			cliAutoApprove: this.#autoApprove,
		});
	}

	/**
	 * Whether the `/yolo` bypass is active. A spawned agent's own flag is a copy of the parent's taken
	 * at spawn; the parent probe is read live and can only narrow, so `/yolo off` in the parent revokes
	 * a running child's bypass, and a child whose own flag is off never gains one from its parent.
	 */
	isBypassed(): boolean {
		if (!this.#bypassActive) return false;
		return this.#parentBypassed?.() ?? true;
	}

	/** Turn the `/yolo` bypass on or off. Returns the new state. */
	setBypass(enabled: boolean): boolean {
		this.#bypassActive = enabled;
		return this.#bypassActive;
	}

	/**
	 * The standing per-tool decisions, as the accessor pair the tool wrapper reads and writes. The
	 * collection itself is not handed out, so no caller can clear it or write it into settings.
	 */
	toolDecisions(): SessionToolApprovals {
		return {
			get: key => this.#toolDecisions.get(key),
			set: (key, decision) => {
				this.#toolDecisions.set(key, decision);
			},
		};
	}

	/** Drop the standing per-tool decisions: `/new` and `/resume` replace the work they were granted for. */
	forgetToolDecisions(): void {
		this.#toolDecisions.clear();
	}

	/** Drop the ACP client's standing decisions: a new client answers for itself. */
	forgetClientDecisions(): void {
		this.#clientDecisions.clear();
	}

	/**
	 * Wrap a tool in a permission proxy when an ACP client that implements `requestPermission` is
	 * connected and the tool is in `PERMISSION_REQUIRED_TOOLS`; any other tool is returned unchanged.
	 *
	 * An explicit yolo opt-in (`autoApprove`, the `/yolo` bypass, or a configured
	 * `tools.approvalMode: yolo`) skips the proxy unless the tool's own policy requires a prompt or a
	 * deny. The schema default is `auto`, so a default-config ACP session keeps the client prompt.
	 */
	wrapForClient<T extends AgentTool>(tool: T): T {
		const bridge = this.#host.clientBridge();
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (!PERMISSION_REQUIRED_TOOLS.has(tool.name)) return tool;
		if (this.#isExplicitAutoApprove()) {
			const userPolicies = (this.#host.settings.get("tools.approval") ?? {}) as Record<string, unknown>;
			const toolPolicy = userPolicies[tool.name];
			if (!toolPolicy || toolPolicy === "allow") return tool;
		}
		const decisions = this.#clientDecisions;
		const host = this.#host;
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					const permissionIntent = getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					const command =
						target.name === TOOL.bash && isRecord(args)
							? getStringProperty(args as Record<string, unknown>, "command")
							: undefined;
					const commandContent = command
						? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
						: undefined;
					const persisted = decisions.get(permissionIntent.cacheKey);
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					let raced: PermissionRaceResult;
					try {
						const permissionPromise = bridge.requestPermission!(
							{
								toolCallId,
								toolName: target.name,
								title: permissionIntent.title,
								...(target.name === TOOL.bash ? { kind: "execute" } : {}),
								status: "pending",
								rawInput: args,
								...(commandContent ? { content: commandContent } : {}),
								locations: extractPermissionLocations(args, host.cwd(), permissionIntent.paths),
							},
							PERMISSION_OPTIONS,
							signal,
						).then(outcome => ({ kind: "permission" as const, outcome }));
						raced = await Promise.race([permissionPromise, abortPromise]);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (selectedOption.kind === "allow_always" || selectedOption.kind === "reject_always") {
						decisions.set(permissionIntent.cacheKey, selectedOption.kind);
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	#isExplicitAutoApprove(): boolean {
		return (
			this.#autoApprove ||
			this.isBypassed() ||
			(this.#host.settings.isConfigured("tools.approvalMode") &&
				this.#host.settings.get("tools.approvalMode") === "yolo")
		);
	}
}
