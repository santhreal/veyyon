import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage, type SessionStorage } from "../session/session-storage";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_RESULT_CHARS = 16_000;
const MAX_REPLAY_ENTRIES = 256;

export interface NativeControlBinding {
	authToken: string;
	actorId: string;
	chatId: string;
	sessionId: string;
	workspaceRoots: readonly string[];
}

export interface NativeControlAuth {
	authToken: string;
	actorId: string;
	chatId: string;
	sessionId: string;
}

export interface AgentListRequest extends NativeControlAuth {
	cursor?: string;
	limit?: number;
}

export interface AgentDetailRequest extends NativeControlAuth {
	agentId: string;
}

export interface CreateSessionRequest extends NativeControlAuth {
	requestId: string;
	workspace: string;
	title?: string;
}

export interface NativeAgentSummary {
	id: string;
	name: string;
	status: AgentRef["status"];
	summary?: string;
	updatedAt: number;
}

export interface NativeAgentDetail extends NativeAgentSummary {
	progress?: string;
	result?: string;
}

export interface NativeSessionIdentity {
	id: string;
	actorId: string;
	chatId: string;
}

export interface CreatedNativeSession {
	id: string;
	workspace: string;
	title?: string;
	file: string;
}

export interface NativeControlBridgeOptions {
	binding: NativeControlBinding;
	registry?: AgentRegistry;
	storage?: SessionStorage;
	sessionDirFor?: (workspace: string) => string | undefined;
}

export class NativeControlDeniedError extends Error {
	constructor(
		readonly code:
			| "UNAUTHORIZED"
			| "ACTOR_MISMATCH"
			| "CHAT_MISMATCH"
			| "SESSION_MISMATCH"
			| "SESSION_NOT_ACTIVE"
			| "AGENT_NOT_FOUND"
			| "INVALID_CURSOR"
			| "WORKSPACE_DENIED"
			| "REPLAY_MISMATCH",
		message: string,
	) {
		super(message);
		this.name = "NativeControlDeniedError";
	}
}

interface ReplayEntry {
	fingerprint: string;
	result: CreatedNativeSession;
}

function tokenMatches(expected: string, candidate: string): boolean {
	const expectedBytes = Buffer.from(expected, "utf8");
	const candidateBytes = Buffer.from(candidate, "utf8");
	return expectedBytes.length === candidateBytes.length && crypto.timingSafeEqual(expectedBytes, candidateBytes);
}

function sanitized(value: string | undefined, maxChars: number): string | undefined {
	if (!value) return undefined;
	const clean = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function normalizedForComparison(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(normalizedForComparison(root), normalizedForComparison(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_PAGE_SIZE);
}

function cursorOffset(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^(0|[1-9]\d*)$/.test(cursor)) {
		throw new NativeControlDeniedError("INVALID_CURSOR", "Cursor must be a non-negative decimal offset");
	}
	const offset = Number(cursor);
	if (!Number.isSafeInteger(offset)) {
		throw new NativeControlDeniedError("INVALID_CURSOR", "Cursor exceeds the safe pagination range");
	}
	return offset;
}

export class TelegramNativeControlBridge {
	readonly #binding: NativeControlBinding;
	readonly #registry: AgentRegistry;
	readonly #storage: SessionStorage;
	readonly #sessionDirFor: (workspace: string) => string | undefined;
	readonly #replays = new Map<string, ReplayEntry>();

	constructor(options: NativeControlBridgeOptions) {
		if (options.binding.authToken.length < 32) {
			throw new Error("Native control authToken must contain at least 32 characters");
		}
		if (options.binding.workspaceRoots.length === 0) {
			throw new Error("Native control requires at least one workspace root");
		}
		this.#binding = { ...options.binding, workspaceRoots: [...options.binding.workspaceRoots] };
		this.#registry = options.registry ?? AgentRegistry.global();
		this.#storage = options.storage ?? new FileSessionStorage();
		this.#sessionDirFor = options.sessionDirFor ?? (() => undefined);
	}

	getSessionIdentity(auth: NativeControlAuth): NativeSessionIdentity {
		this.#authorize(auth);
		return { id: this.#binding.sessionId, actorId: this.#binding.actorId, chatId: this.#binding.chatId };
	}

	async listAgents(request: AgentListRequest): Promise<{ items: NativeAgentSummary[]; nextCursor?: string }> {
		this.#authorize(request);
		const offset = cursorOffset(request.cursor);
		const limit = boundedLimit(request.limit);
		const refs = this.#registry
			.list()
			.filter(ref => ref.scope === this.#binding.sessionId && ref.kind !== "advisor")
			.sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
		const items = refs.slice(offset, offset + limit).map(ref => this.#summary(ref));
		const nextOffset = offset + items.length;
		return { items, ...(nextOffset < refs.length ? { nextCursor: String(nextOffset) } : {}) };
	}

	async getAgentDetail(request: AgentDetailRequest): Promise<NativeAgentDetail> {
		this.#authorize(request);
		const ref = this.#registry.get(request.agentId);
		if (!ref || ref.scope !== this.#binding.sessionId || ref.kind === "advisor") {
			throw new NativeControlDeniedError("AGENT_NOT_FOUND", "Agent is not available in the bound session");
		}
		const progress = sanitized(ref.activity, MAX_SUMMARY_CHARS);
		const result = sanitized(ref.session?.getLastAssistantText(), MAX_RESULT_CHARS);
		return { ...this.#summary(ref), ...(progress ? { progress } : {}), ...(result ? { result } : {}) };
	}

	async createSession(request: CreateSessionRequest): Promise<CreatedNativeSession> {
		this.#authorize(request);
		if (!request.requestId.trim()) {
			throw new NativeControlDeniedError("REPLAY_MISMATCH", "Session creation requires a non-empty requestId");
		}
		const workspace = await this.#allowedWorkspace(request.workspace);
		const title = sanitized(request.title?.trim(), MAX_SUMMARY_CHARS);
		const fingerprint = JSON.stringify({ workspace: normalizedForComparison(workspace), title: title ?? null });
		const replayKey = `${this.#binding.actorId}\u0000${this.#binding.chatId}\u0000${request.requestId}`;
		const prior = this.#replays.get(replayKey);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				throw new NativeControlDeniedError("REPLAY_MISMATCH", "requestId was already used with a different session request");
			}
			return prior.result;
		}

		const manager = SessionManager.create(workspace, this.#sessionDirFor(workspace), this.#storage);
		if (title) await manager.setSessionName(title, "user");
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("SessionManager did not persist the created session");
		const result: CreatedNativeSession = {
			id: manager.getSessionId(),
			workspace: manager.getCwd(),
			...(title ? { title } : {}),
			file,
		};
		this.#replays.set(replayKey, { fingerprint, result });
		while (this.#replays.size > MAX_REPLAY_ENTRIES) {
			const oldest = this.#replays.keys().next().value;
			if (oldest === undefined) break;
			this.#replays.delete(oldest);
		}
		return result;
	}

	#authorize(auth: NativeControlAuth): void {
		if (!tokenMatches(this.#binding.authToken, auth.authToken)) {
			throw new NativeControlDeniedError("UNAUTHORIZED", "Invalid native control credential");
		}
		if (auth.actorId !== this.#binding.actorId) {
			throw new NativeControlDeniedError("ACTOR_MISMATCH", "Actor is not bound to this native control bridge");
		}
		if (auth.chatId !== this.#binding.chatId) {
			throw new NativeControlDeniedError("CHAT_MISMATCH", "Chat is not bound to this native control bridge");
		}
		if (auth.sessionId !== this.#binding.sessionId) {
			throw new NativeControlDeniedError("SESSION_MISMATCH", "Session is not bound to this native control bridge");
		}
	}

	#summary(ref: AgentRef): NativeAgentSummary {
		const summary = sanitized(ref.activity, MAX_SUMMARY_CHARS);
		return {
			id: ref.id,
			name: sanitized(ref.displayName, MAX_SUMMARY_CHARS) ?? ref.id,
			status: ref.status,
			...(summary ? { summary } : {}),
			updatedAt: ref.lastActivity,
		};
	}

	async #allowedWorkspace(requested: string): Promise<string> {
		let candidate: string;
		try {
			candidate = await fs.realpath(path.resolve(requested));
			const stat = await fs.stat(candidate);
			if (!stat.isDirectory()) throw new Error("not a directory");
		} catch {
			throw new NativeControlDeniedError("WORKSPACE_DENIED", "Workspace must be an existing directory");
		}
		for (const configuredRoot of this.#binding.workspaceRoots) {
			try {
				const root = await fs.realpath(path.resolve(configuredRoot));
				if (isWithin(root, candidate)) return candidate;
			} catch {
				// A missing configured root grants nothing.
			}
		}
		throw new NativeControlDeniedError("WORKSPACE_DENIED", "Workspace is outside the configured allowlist");
	}
}
