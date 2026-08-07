/**
 * report_tool_issue — automated QA tool for tracking unexpected tool behavior.
 *
 * Enabled only by VEYYON_AUTO_QA=1 or the per-profile `dev.autoqa` setting.
 * When enabled, every agent records grievances in the profile's local SQLite
 * database. Recording never waits for or depends on the network.
 *
 * Automatic upload is a separate per-profile opt-in:
 * `dev.autoqaPush.enabled`, which defaults to false. The bundled endpoint is
 * https://veyyon.dev/api/grievances. Each insert schedules a background flush
 * only when that toggle is on. `VEYYON_AUTO_QA_PUSH=1` remains the explicit
 * headless override, and `veyyon grievances push` remains the explicit
 * one-shot command. Tool execution never blocks on the network and never throws.
 */
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
	// Enum gives the model a tight schema; the runtime check in `execute` is the
	// source of truth (handles models that ignore the enum and the empty-list
	// fallback used by call sites that don't know the active set yet).
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

/**
 * Open (or return the cached handle for) the auto-QA SQLite database at
 * `~/.veyyon/autoqa.db` (XDG-aware via `getAutoQaDbDir`). Idempotently runs schema creation, the
 * `pushed`-column migration, and index setup so every consumer — tool
 * execute path, manual `veyyon grievances push`, future debug scripts —
 * sees the same prepared schema. Returns `null` only on a hard open
 * failure (filesystem permissions, etc.); a missing file is created.
 *
 * Exported because the `veyyon grievances` CLI handlers need the migrated
 * handle too — having a second `openDb` in the CLI led to the column
 * never being added on the manual-push path.
 */
export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	try {
		const db = new Database(getAutoQaDbDir());
		// Install the busy handler BEFORE any lock-taking statement. See #2421.
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
		// Migration: pre-`pushed` databases get the column tacked on. Existing
		// rows default to `0` (unpushed), so legacy grievances from before the
		// consent + push pipeline went live get swept up by the next flush —
		// exactly the behaviour we want for users who just granted consent.
		const cols = db.prepare("PRAGMA table_info(grievances)").all() as Array<{ name: string }>;
		if (!cols.some(c => c.name === "pushed")) {
			db.run("ALTER TABLE grievances ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0");
		}
		// Speed up the per-batch `WHERE pushed = 0` scan that drives the flush
		// loop. Without the index every batch becomes a full table scan once
		// pushed rows dominate the table.
		db.run("CREATE INDEX IF NOT EXISTS grievances_pushed_idx ON grievances(pushed, id)");
		cachedDb = db;
		return db;
	} catch (error) {
		// Every caller reads null as "auto-QA is not set up", and the CLI used to say so in as many
		// words. A hard open failure is a different fact: reports are being dropped on a machine that
		// asked for them, so it is named here rather than inferred from an empty list.
		logger.warn("Auto-QA database could not be opened; tool issue reports cannot be recorded", {
			path: getAutoQaDbDir(),
			error: errorMessage(error),
		});
		return null;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Backend push
// ───────────────────────────────────────────────────────────────────────────

export interface FlushResult {
	pushed: number;
	ok: boolean;
	skipped?: boolean;
}

/**
 * Optional per-flush controls. Used by `veyyon grievances push` to surface
 * progress to a TTY and to override the per-profile automatic-upload toggle.
 */
export type AutoQaSanitizer = (text: string) => string;

export interface FlushOptions {
	/**
	 * Upload even when `dev.autoqaPush.enabled` is false. Endpoint configuration
	 * is still required. Reserved for explicit user-driven pushes.
	 */
	forceUpload?: boolean;
	/**
	 * Resolve the current provider-bound sanitizer immediately before each
	 * physical POST. Auto-flush supplies a live session resolver so a queued
	 * upload cannot use a stale transform after the provider state refreshes.
	 *
	 * Explicit manual pushes without a session intentionally omit this: the
	 * user's command is an explicit request to ship the locally stored rows.
	 */
	resolveSanitizer?: () => AutoQaSanitizer | undefined;
	/**
	 * Fetch implementation for the push POST. Defaults to global fetch.
	 */
	fetch?: FetchImpl;
	/**
	 * Fires once at the start of the loop with the snapshot count of
	 * unpushed rows. Subsequent inserts won't be reflected (the count is
	 * a planning hint for progress reporters, not a live total).
	 */
	onStart?: (totalUnpushed: number) => void;
	/**
	 * Fires after every successfully shipped batch with the running pushed
	 * count. Reporters compare against the `totalUnpushed` they saw in
	 * `onStart` to advance their bar.
	 */
	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;
/**
 * Per-request batch size. The worker loops until no unpushed rows remain,
 * shipping `FLUSH_BATCH_SIZE` rows per POST. Tunes the trade-off between
 * request count and request size — 50 keeps each payload well under the
 * default `maxBody` limit on the autoqa collector while letting a
 * realistic backlog (a few hundred legacy rows on first flush after the
 * consent grant) drain in single-digit requests.
 */
const FLUSH_BATCH_SIZE = 50;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

/** Test-only: clear single-flight + cooldown state. Never call from production code. */
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

	// The profile toggle is the ordinary network boundary. The environment
	// override exists for headless QA runs, while `forceUpload` is used only by an
	// explicit `veyyon grievances push` command.
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

/**
 * Clone a JSON-shaped auto-QA payload while sanitizing every string value and
 * every object key. The database rows remain raw/local; only the outbound copy
 * is transformed. Object keys matter because reports can contain structured
 * metadata whose property names are model-controlled.
 */
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
	// Planning snapshot — fires once so progress reporters can size their bar.
	// Mid-flight inserts are NOT folded in (the worker drains them too, but
	// the progress bar treats the initial backlog as the denominator).
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
			// Coarse host fingerprint for triage — `darwin`/`linux`/`win32` +
			// `arm64`/`x64`. Useful for "is this bug arch-specific?" without
			// leaking the user's machine name (the old payload sent
			// `os.hostname()` verbatim, which trivially deanonymises users).
			platform: process.platform,
			arch: process.arch,
			entries: rows,
		};
		let body: string;
		try {
			// Resolve after the queue read and immediately before serialization /
			// fetch. Resolve again for every batch after an intervening POST.
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
		// Scoped rather than bare AbortSignal.timeout: a bare timeout leaves its
		// backing timer armed for the full window after the fetch settles.
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
			// Fetch errors can include the request URL or body. Neither is safe
			// diagnostic material at this confidentiality boundary.
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

		// Mark just this batch — never touch ids the SELECT didn't return so a
		// concurrent insert that landed mid-flight isn't claimed-as-shipped on
		// our behalf. `id IN (?, ?, …)` rather than a range so a non-contiguous
		// batch (after partial fills, retries, etc.) still flips exactly what
		// we sent.
		const ids = rows.map(r => r.id);
		const placeholders = sqlPlaceholders(ids.length);
		db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
		totalPushed += rows.length;
		options.onProgress?.(totalPushed);
		// Loop continues; the next SELECT picks up the next batch (or returns
		// empty, exiting the loop).
	}
}

/**
 * Flush queued grievances to the configured backend.
 *
 * Single-flight: concurrent callers share the in-flight promise. After a
 * failed push, retries are skipped for {@link FAILURE_COOLDOWN_MS} ms.
 * Never throws — all errors are caught and routed to the logger.
 */
export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.forceUpload === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	// An explicit "ship now" skips the automatic retry cooldown so the command
	// can immediately retry a transient failure.
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
	// Snapshotted at construction time. The model's enum is built from the same
	// snapshot; mid-session drift (extensions registering later, etc.) is caught
	// by the silent-drop guard below.
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
			// Save is unconditional: the row lives in this profile's local
			// autoqa.db. The operator owns it and can inspect or remove it through
			// `veyyon grievances`. The profile's separate auto-upload toggle is
			// enforced inside `flushGrievances`.
			try {
				const params = rawParams as { tool: string; report: string };
				// Some models emit `proxy_<name>` for tools routed through a
				// passthrough wrapper. Strip the prefix before allowlist check so
				// `proxy_read` lands as a report against `read`, not a silent drop.
				const canonicalTool = params.tool.startsWith("proxy_") ? params.tool.slice("proxy_".length) : params.tool;
				// Silently drop reports targeting tools that aren't shipped built-ins
				// (MCP servers, extensions that overrode a built-in name, typos).
				// Not the model's fault: no error, no DB row, just acknowledge.
				// Empty allowlist means the factory was called without a known active
				// set, so behave as before and record everything.
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
					// Fire and forget. A disabled toggle returns before network I/O;
					// an enabled one drains all queued rows through the live secret
					// sanitizer. The tool response never waits for either branch.
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
