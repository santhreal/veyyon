import { Database } from "bun:sqlite";
import type { AgentTool } from "@veyyon/agent-core";
import type { FetchImpl } from "@veyyon/ai";
import {
	$env,
	$flag,
	errorMessage,
	getAutoQaDbDir,
	getInstallId,
	logger,
	scopedTimeoutSignal,
	VERSION,
} from "@veyyon/utils";
import { sqlPlaceholders } from "@veyyon/utils/sqlite";
import { type } from "arktype";
import type { Settings } from "..";
import type { ToolSession } from "./index";

function buildReportToolIssueParams(activeBuiltinNames: readonly string[]) {
	const toolSchema = activeBuiltinNames.length > 0 ? type.enumerated(...activeBuiltinNames) : type("string");
	return type({
		tool: toolSchema.describe("tool name"),
		report: type("string").describe(
			"unexpected behavior; generic, NEVER PII (paths, file contents, identifiers, prompt text)",
		),
	});
}

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("VEYYON_AUTO_QA", !!settings?.get("dev.autoqa"));
}

let cachedDb: Database | null = null;

export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	try {
		const db = new Database(getAutoQaDbDir());
		db.run("PRAGMA busy_timeout = 5000");
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				pushed INTEGER NOT NULL DEFAULT 0
			);
		`);
		const cols = db.prepare("PRAGMA table_info(grievances)").all() as Array<{ name: string }>;
		if (!cols.some(c => c.name === "pushed")) {
			db.run("ALTER TABLE grievances ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0");
		}
		db.run("CREATE INDEX IF NOT EXISTS grievances_pushed_idx ON grievances(pushed, id)");
		cachedDb = db;
		return db;
	} catch (error) {
		logger.warn("Auto-QA database could not be opened; tool issue reports cannot be recorded", {
			path: getAutoQaDbDir(),
			error: errorMessage(error),
		});
		return null;
	}
}

export interface FlushResult {
	pushed: number;
	ok: boolean;
	skipped?: boolean;
}

export type AutoQaSanitizer = (text: string) => string;

export interface FlushOptions {
	forceUpload?: boolean;
	resolveSanitizer?: () => AutoQaSanitizer | undefined;
	fetch?: FetchImpl;
	onStart?: (totalUnpushed: number) => void;
	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;
const FLUSH_BATCH_SIZE = 50;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

export function __resetAutoQaFlushStateForTests(): void {
	inFlightFlush = null;
	lastFailureAt = 0;
}

function envOverrideString(name: string): string | undefined {
	const value = $env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePushConfig(settings: Settings | undefined, forceUpload: boolean): PushConfig | null {
	if (!forceUpload && !isAutoQaEnabled(settings)) return null;

	if (!forceUpload && settings?.get("dev.autoqaPush.enabled") !== true && !$flag("VEYYON_AUTO_QA_PUSH")) {
		return null;
	}

	const endpoint = envOverrideString("VEYYON_AUTO_QA_PUSH_URL") ?? settings?.get("dev.autoqaPush.endpoint");
	if (!endpoint || endpoint.trim().length === 0) return null;

	const token = envOverrideString("VEYYON_AUTO_QA_PUSH_TOKEN") ?? settings?.get("dev.autoqaPush.token");
	return { endpoint: endpoint.trim(), token: token && token.length > 0 ? token : undefined };
}

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

export function sanitizeAutoQaPayload(value: unknown, sanitize: AutoQaSanitizer): unknown {
	const seen = new WeakMap<object, unknown>();
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") return sanitize(node);
		if (node === null || typeof node !== "object") return node;

		const prior = seen.get(node);
		if (prior !== undefined) return prior;
		if (Array.isArray(node)) {
			const clone: unknown[] = [];
			seen.set(node, clone);
			for (const item of node) clone.push(visit(item));
			return clone;
		}

		const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		seen.set(node, clone);
		for (const [key, item] of Object.entries(node)) {
			clone[sanitize(key)] = visit(item);
		}
		return clone;
	};
	return visit(value);
}

async function performFlush(db: Database, config: PushConfig, options: FlushOptions = {}): Promise<FlushResult> {
	const selectStmt = db.prepare(
		"SELECT id, model, version, tool, report FROM grievances WHERE pushed = 0 ORDER BY id ASC LIMIT ?",
	);
	if (options.onStart) {
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM grievances WHERE pushed = 0").get() as { n: number };
		options.onStart(totalRow.n);
	}
	const fetchImpl = options.fetch ?? fetch;
	let totalPushed = 0;
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) return { pushed: totalPushed, ok: true };

		const rawPayload = {
			agent: { name: "veyyon", version: VERSION },
			installId: getInstallId(),
			platform: process.platform,
			arch: process.arch,
			entries: rows,
		};
		let body: string;
		try {
			const sanitize = options.resolveSanitizer?.() ?? ((text: string) => text);
			body = JSON.stringify(sanitizeAutoQaPayload(rawPayload, sanitize));
		} catch {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				reason: "outbound payload sanitation failed",
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token) headers.authorization = `Bearer ${config.token}`;

		let response: Response;
		const flushTimeout = scopedTimeoutSignal(FLUSH_TIMEOUT_MS);
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers,
				body,
				signal: flushTimeout.signal,
			});
		} catch {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				reason: "network request failed",
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		} finally {
			flushTimeout.cancel();
		}

		if (!response.ok) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				status: response.status,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		const ids = rows.map(r => r.id);
		const placeholders = sqlPlaceholders(ids.length);
		db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
		totalPushed += rows.length;
		options.onProgress?.(totalPushed);
	}
}

export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.forceUpload === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	const bypass = options.forceUpload === true;
	if (!bypass && inFlightFlush) return inFlightFlush;

	if (!bypass && lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
		return { pushed: 0, ok: false, skipped: true };
	}

	const handle = db ?? openAutoQaDb();
	if (!handle) return { pushed: 0, ok: false, skipped: true };

	const promise = (async () => {
		try {
			return await performFlush(handle, config, options);
		} catch {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", { reason: "unexpected flush failure" });
			return { pushed: 0, ok: false };
		}
	})();

	if (!bypass) inFlightFlush = promise;
	try {
		return await promise;
	} finally {
		if (!bypass) inFlightFlush = null;
	}
}

export function createReportToolIssueTool(session: ToolSession, activeBuiltinNames: readonly string[] = []): AgentTool {
	const getModel = () => session.getActiveModelString?.() ?? "unknown";
	const allowedToolNames = new Set(activeBuiltinNames);

	return {
		name: "report_tool_issue",
		label: "Report Tool Issue",
		strict: false,
		approval: "write",
		description: "Report unexpected tool behavior for automated QA tracking.",
		parameters: buildReportToolIssueParams(activeBuiltinNames),
		intent: "omit",
		async execute(_toolCallId, rawParams) {
			try {
				const params = rawParams as { tool: string; report: string };
				const canonicalTool = params.tool.startsWith("proxy_") ? params.tool.slice("proxy_".length) : params.tool;
				if (allowedToolNames.size > 0 && !allowedToolNames.has(canonicalTool)) {
					return { content: [{ type: "text", text: "Noted, thanks!" }] };
				}
				const db = openAutoQaDb();
				if (db) {
					db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
						getModel(),
						VERSION,
						canonicalTool,
						params.report,
					);
					void flushGrievances(db, session.settings, {
						resolveSanitizer: () => session.obfuscateProviderText,
					});
				}
			} catch (error) {
				logger.error("Failed to record tool issue", { error });
			}
			return {
				content: [{ type: "text", text: "Noted, thanks!" }],
			};
		},
	};
}
