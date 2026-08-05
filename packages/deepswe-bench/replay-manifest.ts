import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMPARISON_MODEL } from "./system-comparison";

export interface ReplayUserTurn {
	id: string;
	content: string;
}

export interface ReplayManifest {
	schema_version: 1;
	model: typeof COMPARISON_MODEL;
	source_session_id: string;
	source_session_artifacts: string[];
	repository_checkpoint: string;
	repository_checkpoint_sha256: string;
	compaction_checkpoint: {
		/** 1-based turn count: compact immediately after this user turn finishes. */
		after_user_turn: number;
		source_boundary_id: string;
		source_threshold_tokens: number;
		source_context_tokens: number;
	};
	/** Ordered source USER turns only. Assistant/tool messages are never imported. */
	user_turns: ReplayUserTurn[];
	/** Exactly one original-session continuation, withheld from prefix replay. */
	held_out_continuation: ReplayUserTurn;
}

export interface LoadedReplayManifest {
	path: string;
	bytes: Uint8Array;
	sha256: string;
	manifest: ReplayManifest;
}

export class InvalidReplayManifest extends Error {
	readonly issues: string[];

	constructor(file: string, issues: string[]) {
		super(`invalid replay manifest ${file}:\n${issues.map(issue => `- ${issue}`).join("\n")}`);
		this.name = "InvalidReplayManifest";
		this.issues = issues;
	}
}

const ROOT_KEYS = [
	"schema_version",
	"model",
	"source_session_id",
	"source_session_artifacts",
	"repository_checkpoint",
	"repository_checkpoint_sha256",
	"compaction_checkpoint",
	"user_turns",
	"held_out_continuation",
] as const;
const CHECKPOINT_KEYS = [
	"after_user_turn",
	"source_boundary_id",
	"source_threshold_tokens",
	"source_context_tokens",
] as const;
const TURN_KEYS = ["id", "content"] as const;

function recordAt(value: unknown, label: string, issues: string[]): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		issues.push(`${label} must be an object`);
		return null;
	}
	return value as Record<string, unknown>;
}

function requireExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
	issues: string[],
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) issues.push(`${label} contains unsupported key ${JSON.stringify(key)}`);
	}
	for (const key of allowed) {
		if (!(key in value)) issues.push(`${label} is missing ${JSON.stringify(key)}`);
	}
}

function requireText(value: unknown, label: string, issues: string[]): value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push(`${label} must be non-empty text`);
		return false;
	}
	return true;
}

function requirePositiveInteger(value: unknown, label: string, issues: string[]): value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		issues.push(`${label} must be a positive integer`);
		return false;
	}
	return true;
}

function validateTurn(value: unknown, label: string, issues: string[]): ReplayUserTurn | null {
	const turn = recordAt(value, label, issues);
	if (!turn) return null;
	requireExactKeys(turn, TURN_KEYS, label, issues);
	const idOk = requireText(turn.id, `${label}.id`, issues);
	const contentOk = requireText(turn.content, `${label}.content`, issues);
	return idOk && contentOk ? { id: turn.id as string, content: turn.content as string } : null;
}

/**
 * Load and validate the exact bytes every system adapter receives. Validation is
 * intentionally stricter than a permissive parser: role/assistant/tool fields,
 * relative checkpoint paths, model fallbacks, and ambiguous boundaries fail loud.
 */
export function loadReplayManifest(file: string): LoadedReplayManifest {
	const absolute = path.resolve(file);
	const issues: string[] = [];
	if (!path.isAbsolute(file)) issues.push("manifest path must be absolute so every adapter receives the same file");
	let bytes: Uint8Array;
	let parsed: unknown;
	try {
		bytes = fs.readFileSync(absolute);
		parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch (error) {
		throw new InvalidReplayManifest(absolute, [`cannot read/parse JSON: ${String(error)}`]);
	}
	const root = recordAt(parsed, "manifest", issues);
	if (root) {
		requireExactKeys(root, ROOT_KEYS, "manifest", issues);
		if (root.schema_version !== 1) issues.push("schema_version must be 1");
		if (root.model !== COMPARISON_MODEL) issues.push(`model must be exactly ${COMPARISON_MODEL}`);
		requireText(root.source_session_id, "source_session_id", issues);
		if (!Array.isArray(root.source_session_artifacts) || root.source_session_artifacts.length === 0) {
			issues.push("source_session_artifacts must be a non-empty array");
		} else {
			for (const [index, artifact] of root.source_session_artifacts.entries()) {
				if (requireText(artifact, `source_session_artifacts[${index}]`, issues)) {
					if (!path.isAbsolute(artifact)) {
						issues.push(`source_session_artifacts[${index}] must be an absolute path`);
					} else if (!fs.existsSync(artifact)) {
						issues.push(`source_session_artifacts[${index}] does not exist`);
					}
				}
			}
		}
		if (requireText(root.repository_checkpoint, "repository_checkpoint", issues)) {
			if (!path.isAbsolute(root.repository_checkpoint)) {
				issues.push("repository_checkpoint must be an absolute path/worktree");
			} else if (
				!fs.existsSync(root.repository_checkpoint) ||
				!fs.statSync(root.repository_checkpoint).isDirectory()
			) {
				issues.push("repository_checkpoint must be an existing worktree directory");
			}
		}
		if (
			typeof root.repository_checkpoint_sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(root.repository_checkpoint_sha256)
		) {
			issues.push("repository_checkpoint_sha256 must be a 64-character lowercase hex digest");
		}

		const checkpoint = recordAt(root.compaction_checkpoint, "compaction_checkpoint", issues);
		let afterUserTurn: number | null = null;
		if (checkpoint) {
			requireExactKeys(checkpoint, CHECKPOINT_KEYS, "compaction_checkpoint", issues);
			if (requirePositiveInteger(checkpoint.after_user_turn, "compaction_checkpoint.after_user_turn", issues)) {
				afterUserTurn = checkpoint.after_user_turn as number;
			}
			requireText(checkpoint.source_boundary_id, "compaction_checkpoint.source_boundary_id", issues);
			requirePositiveInteger(
				checkpoint.source_threshold_tokens,
				"compaction_checkpoint.source_threshold_tokens",
				issues,
			);
			if (
				requirePositiveInteger(
					checkpoint.source_context_tokens,
					"compaction_checkpoint.source_context_tokens",
					issues,
				)
			) {
				if (
					Number.isSafeInteger(checkpoint.source_threshold_tokens) &&
					(checkpoint.source_context_tokens as number) < (checkpoint.source_threshold_tokens as number)
				) {
					issues.push("source_context_tokens must meet or exceed the actual compaction threshold");
				}
			}
		}

		if (!Array.isArray(root.user_turns) || root.user_turns.length === 0) {
			issues.push("user_turns must contain ordered source user turns");
		} else {
			const ids = new Set<string>();
			for (const [index, value] of root.user_turns.entries()) {
				const turn = validateTurn(value, `user_turns[${index}]`, issues);
				if (turn) {
					if (ids.has(turn.id)) issues.push(`user_turns[${index}].id duplicates an earlier turn`);
					ids.add(turn.id);
				}
			}
			if (afterUserTurn !== null && afterUserTurn !== root.user_turns.length) {
				issues.push("compaction_checkpoint.after_user_turn must equal the frozen replay prefix length");
			}
		}
		validateTurn(root.held_out_continuation, "held_out_continuation", issues);
	}
	if (issues.length > 0) throw new InvalidReplayManifest(absolute, issues);
	return {
		path: absolute,
		bytes: bytes!,
		sha256: createHash("sha256").update(bytes!).digest("hex"),
		manifest: parsed as ReplayManifest,
	};
}
