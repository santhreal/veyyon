/**
 * The messages a session delivers about work that finished outside a turn: an
 * async job's result, a diagnostic that arrived late, an MCP notification, and the
 * notice that secret protection is unavailable.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import { prompt } from "@veyyon/utils";
import type { AsyncJobType } from "../async";
import { toolsPrompts } from "../prompts/tools/rows";
import { vaultKeyPath } from "../secrets/vault-crypto";
import type { DeferredDiagnosticsEntry } from "../tools";
import type { AsyncResultEntry } from "./agent-session-types";
import { type CustomMessage, LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "./messages";

export type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

export type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

/**
 * The operator-facing text for a session that cannot initialize secret protection.
 *
 * Starting anyway was considered and rejected. Degrading to a no-secrets session
 * reads like the kind option, but it is fail-OPEN on a security control: without a
 * placeholder key there is no obfuscator, and the obfuscator is what REDACTS. Stored
 * secrets would merely be unavailable, which is survivable, but env-derived values
 * that this session would have redacted reach the model, the transcript and the
 * session file in the clear. The operator turned protection on deliberately; quietly
 * running without it is worse than not starting, because nothing on screen would say
 * the guarantee had lapsed.
 *
 * So the failure stays fatal and becomes a decision instead of a stack trace: it names
 * the key path, the causes worth checking, and the one command that starts veyyon
 * without protection if that is genuinely what the operator wants.
 */
export function secretProtectionUnavailableMessage(globalConfigRoot: string): string {
	return [
		`Secret protection is enabled but its key at ${vaultKeyPath(globalConfigRoot)} could not be initialized, so this session cannot redact or expand secrets.`,
		`Check that ${globalConfigRoot} is a real directory you own and can write to, that it is not a symlink and not on a read-only or exotic filesystem, then retry.`,
		"To start without secret protection instead, run: veyyon config set secrets.enabled false",
	].join("\n");
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(toolsPrompts["tools/async-result"].text, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

export type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};

export function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<LateDiagnosticsDetails> | null {
	if (entries.length === 0) return null;
	const files = entries.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		messages: entry.messages,
		errored: entry.errored,
	}));
	const details: LateDiagnosticsDetails = {
		files: files.map(file => ({
			path: file.path,
			summary: file.summary,
			errored: file.errored,
			messages: file.messages,
		})),
	};
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(toolsPrompts["tools/lsp-late-diagnostic"].text, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

export function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}
