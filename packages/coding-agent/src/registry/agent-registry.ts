import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";
import type {
	AgentRef,
	AgentStatus,
	PendingApproval,
	RegisterInput,
	RegistryEvent,
	RegistryListener,
} from "./agent-registry-helpers";
import { MAIN_AGENT_ID } from "./agent-registry-helpers";

export type { AgentKind } from "./agent-registry-helpers";
export { AGENT_STATUSES, mainAgentIdFor } from "./agent-registry-helpers";
export type { AgentRef, AgentStatus, RegistryEvent };
export { MAIN_AGENT_ID };

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
			model: input.model,
			scope: input.scope ?? this.#deriveScope(input),
		};
		const displaced = this.#refs.get(ref.id);
		if (displaced && displaced.sessionFile !== ref.sessionFile) {
			logger.error("Agent registry id reused by a different agent; the displaced agent loses its row", {
				id: ref.id,
				displacedSessionFile: displaced.sessionFile,
				displacedStatus: displaced.status,
				sessionFile: ref.sessionFile,
			});
		}
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	#deriveScope(input: RegisterInput): string | undefined {
		if (input.parentId) return this.#refs.get(input.parentId)?.scope;
		return input.kind === "main" ? (input.sessionFile ?? undefined) : undefined;
	}

	setStatus(id: string, status: AgentStatus): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === status) return;
		ref.status = status;
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	noteTurn(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.lastActivity = Date.now();
	}

	setWaitingOnPeer(id: string, waiting: boolean): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.waitingOnPeer = waiting;
	}

	setPendingApproval(id: string, pending: PendingApproval | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		const open = ref.pendingApproval;
		if (open === undefined && pending === undefined) return;
		if (open !== undefined) {
			ref.approvalWaitedMs = (ref.approvalWaitedMs ?? 0) + Math.max(0, Date.now() - open.since);
		}
		ref.pendingApproval = pending;
		this.#emit({ type: "status_changed", ref });
	}

	pendingApprovalSince(id: string): number | undefined {
		return this.#refs.get(id)?.pendingApproval?.since;
	}

	approvalWaitedMs(id: string): number {
		return this.#refs.get(id)?.approvalWaitedMs ?? 0;
	}

	attachSession(id: string, session: AgentSession, sessionFile?: string | null): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
	}

	detachSession(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = null;
	}

	unregister(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
	}

	rescope(id: string, scope: string | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.scope === scope) return;
		ref.scope = scope;
		const now = Date.now();
		ref.createdAt = now;
		ref.lastActivity = now;
		this.#emit({ type: "status_changed", ref });
	}

	static sameScope(a: string | undefined, b: string | undefined): boolean {
		return !a || !b || a === b;
	}

	listInScope(scope: string | undefined): AgentRef[] {
		return this.list().filter(ref => AgentRegistry.sameScope(ref.scope, scope));
	}

	scopeOf(id: string | undefined): string | undefined {
		return id === undefined ? undefined : this.#refs.get(id)?.scope;
	}

	canAddress(senderId: string, targetId: string): boolean {
		if (senderId === targetId) return false;
		const target = this.#refs.get(targetId);
		if (!target || target.kind === "advisor") return false;
		return AgentRegistry.sameScope(target.scope, this.scopeOf(senderId));
	}

	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => this.canAddress(id, ref.id) && (ref.status === "running" || ref.status === "idle"),
		);
	}

	listAddressableBy(id: string): AgentRef[] {
		return this.list().filter(ref => this.canAddress(id, ref.id) && ref.status !== "aborted");
	}

	mainInScope(scope: string | undefined): AgentRef | undefined {
		let found: AgentRef | undefined;
		for (const ref of this.#refs.values()) {
			if (ref.kind !== "main") continue;
			if (!AgentRegistry.sameScope(ref.scope, scope)) continue;
			if (!found || ref.createdAt >= found.createdAt) found = ref;
		}
		return found;
	}

	resolveId(name: string, senderScope: string | undefined): AgentRef | undefined {
		const exact = this.#refs.get(name);
		if (exact) return exact;
		if (name !== MAIN_AGENT_ID) return undefined;
		return this.mainInScope(senderScope);
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return Array.from(this.#refs.values());
	}

	runningSubagentCount(scope?: string, under?: string): number {
		const subtree = under === undefined ? undefined : new Set(this.descendantsOf(under));
		let count = 0;
		for (const ref of this.#refs.values()) {
			if (ref.kind !== "sub" || ref.status !== "running") continue;
			if (!AgentRegistry.sameScope(ref.scope, scope)) continue;
			if (subtree && !subtree.has(ref.id)) continue;
			count++;
		}
		return count;
	}

	descendantsOf(id: string): string[] {
		const byParent = new Map<string, string[]>();
		for (const ref of this.#refs.values()) {
			if (!ref.parentId) continue;
			const siblings = byParent.get(ref.parentId);
			if (siblings) siblings.push(ref.id);
			else byParent.set(ref.parentId, [ref.id]);
		}
		const found: string[] = [];
		const seen = new Set<string>([id]);
		const queue = [id];
		while (queue.length > 0) {
			const current = queue.shift() as string;
			for (const child of byParent.get(current) ?? []) {
				if (seen.has(child)) continue;
				seen.add(child);
				found.push(child);
				queue.push(child);
			}
		}
		return found;
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("Agent registry listener threw; it missed this event", {
					event: event.type,
					error: errorMessage(error),
				});
			}
		}
	}
}
