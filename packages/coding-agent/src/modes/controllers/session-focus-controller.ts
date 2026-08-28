import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { InteractiveModeContext } from "../types";

export type SessionFocusControllerContext = Pick<
	InteractiveModeContext,
	| "clearTransientSessionUi"
	| "collabGuest"
	| "eventController"
	| "renderInitialMessages"
	| "session"
	| "showStatus"
	| "statusLine"
	| "ui"
	| "unsubscribe"
	| "updateEditorBorderColor"
>;

export class SessionFocusController {
	#focusedAgentId: string | undefined;
	#attachedSession: AgentSession | undefined;
	#registryUnsubscribe: (() => void) | undefined;
	#focusGeneration = 0;
	constructor(
		private ctx: SessionFocusControllerContext,
		private registry: AgentRegistry = AgentRegistry.global(),
		private lifecycle: () => AgentLifecycleManager = () => AgentLifecycleManager.global(),
	) {}

	get focusedAgentId(): string | undefined {
		return this.#focusedAgentId;
	}

	get target(): AgentSession | undefined {
		return this.#attachedSession;
	}

	async focusAgent(id: string): Promise<void> {
		if (this.ctx.collabGuest) throw new Error("Viewing agents is unavailable in a collab session.");
		const ownId = this.ctx.session.getAgentId?.() ?? MAIN_AGENT_ID;
		const scope = this.registry.get(ownId)?.scope;
		if (id === ownId || id === MAIN_AGENT_ID) return this.unfocus();
		const target = this.registry.get(id);
		if (target && !AgentRegistry.sameScope(target.scope, scope)) {
			throw new Error(`Agent ${id} belongs to a different conversation and cannot be viewed from this one.`);
		}
		const gen = ++this.#focusGeneration;
		const session = await this.lifecycle().ensureLive(id);
		if (gen !== this.#focusGeneration) return;
		const current = this.registry.get(id);
		if (!current || current.status === "aborted") {
			throw new Error(
				current
					? `Agent "${id}" was terminated and cannot be viewed.`
					: `Unknown agent "${id}" — it was never registered or has been released.`,
			);
		}
		if (!AgentRegistry.sameScope(current.scope, scope)) {
			throw new Error(`Agent ${id} belongs to a different conversation and cannot be viewed from this one.`);
		}
		if (id === this.#focusedAgentId && session === this.#attachedSession) return;
		this.#focusedAgentId = id;
		this.#attachedSession = session;
		this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
		await this.#attach(session);
		if (gen !== this.#focusGeneration) return;
		this.ctx.showStatus(`Viewing agent ${id} — Esc returns to main, ←← hops to parent`);
	}

	async focusParent(): Promise<void> {
		if (!this.#focusedAgentId) return;
		const parentId = this.registry.get(this.#focusedAgentId)?.parentId;
		const parent = parentId ? this.registry.get(parentId) : undefined;
		if (parent && parent.kind !== "main") return this.focusAgent(parent.id);
		return this.unfocus();
	}

	async unfocus(): Promise<void> {
		const gen = ++this.#focusGeneration;
		if (!this.#focusedAgentId) return;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		await this.#attach(this.ctx.session);
		if (gen !== this.#focusGeneration) return;
		this.ctx.showStatus("Returned to main session");
	}

	dispose(): void {
		this.#focusGeneration++;
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && event.ref.status === "aborted";
		if (gone || dead) {
			const transition = this.unfocus();
			const gen = this.#focusGeneration;
			void transition.then(() => {
				if (gen !== this.#focusGeneration) return;
				this.ctx.showStatus(
					`Agent ${event.ref.id} is ${gone ? "gone" : event.ref.status}; returned to main session`,
				);
			});
			return;
		}
		if (
			event.type === "status_changed" &&
			(event.ref.status === "idle" || event.ref.status === "running") &&
			event.ref.session &&
			event.ref.session !== this.#attachedSession
		) {
			this.#attachedSession = event.ref.session;
			void this.#attach(event.ref.session);
		}
	}

	async #attach(target: AgentSession): Promise<void> {
		this.ctx.unsubscribe?.();
		this.ctx.clearTransientSessionUi();
		this.ctx.eventController.resetTranscriptAnchors();
		this.ctx.eventController.attachTo(target);
		this.ctx.statusLine.setSession(target, this.#focusedAgentId);
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		if (target.isStreaming) await this.ctx.eventController.handleEvent({ type: "agent_start" });
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}
}
