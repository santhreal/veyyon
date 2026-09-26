/**
 * The streaming-edit guard: stops a turn while an `edit` call is still streaming, once the call is
 * known to target an auto-generated file or to carry a patch that cannot apply.
 *
 * This is a session collaborator. It owns the per-turn check state (the abort latch, one scan per
 * streaming `edit` call and the file contents the removed-line check reads) and reaches the
 * session only through {@link StreamingEditGuardHost}.
 *
 * Two checks run while a patch-mode `edit` call streams:
 *
 * - **auto-generated**: once per call and target path, whatever the settings. `assertEditableFile`
 *   rejecting with a `ToolError` stops the turn; any other failure is left to the edit tool.
 * - **patch preview**, only with `edit.streamingAbort`: every removed line must occur in the file.
 *   Each complete line of the diff is scanned once, so a call costs time linear in its diff, not
 *   quadratic in its delta count. When the call ends, a diff with no removed lines goes through
 *   `previewPatch`, and removed lines that could not be read from the cache are checked on disk.
 */

import * as fs from "node:fs";
import type { AssistantMessage, AssistantMessageEvent } from "@veyyon/ai";
import { errorMessage, isEnoent, isRecord, logger } from "@veyyon/utils";
// The owning modules, not the `../../edit` and `../../internal-urls` barrels, which reach dozens and
// hundreds of modules this collaborator never touches.
import { normalizeDiff, ParseError } from "../../edit/diff";
import { previewPatch } from "../../edit/modes/patch";
import { normalizeToLF, stripBom } from "../../edit/normalize";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../../internal-urls/local-protocol";
import { TOOL } from "../../tools/core/builtin-names";
import { normalizeLocalScheme, resolveToCwd } from "../../tools/core/path-utils";
import { ToolError } from "../../tools/core/tool-errors";
import { assertEditableFile } from "../../tools/fs/auto-generated-guard";

/** Internal-scheme URLs with no stable filesystem path; the edit tool rejects them itself. */
const NON_FILESYSTEM_SCHEMES = ["agent://", "skill://", "rule://", "mcp://", "artifact://"] as const;

const PREVIEW_FAILURE = "Streaming edit aborted due to patch preview failure";

/** What {@link StreamingEditGuard} needs from the session that owns it. */
export interface StreamingEditGuardHost {
	/** Stop the running turn. */
	abortTurn(): void;
	/** `edit.streamingAbort`: whether the patch-preview check runs. */
	streamingAbortEnabled(): boolean;
	/** The fuzzy-match options the edit tool applies a patch with. */
	fuzzyMatch(): { allowFuzzy: boolean; fuzzyThreshold: number };
	cwd(): string;
	localProtocol(): LocalProtocolOptions;
	/**
	 * `text` with live secret placeholders expanded for comparison against the file on disk, or
	 * `undefined` when a placeholder cannot be expanded yet. The result is compared and discarded,
	 * never rendered or logged.
	 */
	expandSecretsForDiskComparison(text: string): string | undefined;
	/** `text` re-redacted so a log line never holds an expanded credential. */
	redactForLog(text: string): string;
}

/** One streaming patch-mode `edit` call and how far its diff has been checked. */
interface EditCallScan {
	readonly toolCallId: string;
	/** The `path` argument as streamed; a change starts a new scan. */
	readonly path: string;
	/** Filesystem path of {@link path}; `undefined` for an internal URL with none. */
	readonly resolvedPath: string | undefined;
	/** Offset in the diff just past the last scanned line. */
	scannedEnd: number;
	/** Removed lines scanned so far, secret placeholders expanded. */
	readonly removed: string[];
	/** How many of {@link removed} were found in the cached file. */
	verified: number;
	/** Whether any added or removed line was scanned. */
	changed: boolean;
	/** Set once the check that runs when the call ends has been started. */
	ended: boolean;
}

export class StreamingEditGuard {
	readonly #host: StreamingEditGuardHost;
	#abortTriggered = false;
	/** Scans of this turn's streaming `edit` calls, by tool call id. */
	readonly #scans = new Map<string, EditCallScan>();
	/** The scan tracked last: an auto-generated rejection for any other one is stale. */
	#latestScan: EditCallScan | undefined;
	/** LF-normalized file contents by resolved path, read for the removed-line check. */
	readonly #fileCache = new Map<string, string>();

	constructor(host: StreamingEditGuardHost) {
		this.#host = host;
	}

	/** Whether the guard stopped the current turn. A turn it stopped is settled, never retried. */
	get abortTriggered(): boolean {
		return this.#abortTriggered;
	}

	/** Clear the per-turn state when a turn starts. A check still in flight is then stale. */
	resetForTurn(): void {
		this.#abortTriggered = false;
		this.#scans.clear();
		this.#latestScan = undefined;
		this.#fileCache.clear();
	}

	/** Drop the cached contents of `filePath` once an edit to it completes. */
	invalidate(filePath: string): void {
		const resolvedPath = this.#resolveFsPath(filePath);
		if (resolvedPath === undefined || !this.#fileCache.delete(resolvedPath)) return;
		for (const scan of this.#scans.values()) {
			if (scan.resolvedPath === resolvedPath) scan.verified = 0;
		}
	}

	/** Check one event of the streaming assistant message. Runs synchronously on the stream. */
	observe(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (this.#abortTriggered) return;
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") return;

		const toolCall = message.content[event.contentIndex];
		if (toolCall?.type !== "toolCall" || toolCall.name !== TOOL.edit || !toolCall.id) return;
		const args = toolCall.arguments;
		if (!isRecord(args) || "old_text" in args || "new_text" in args) return;
		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) return;

		let scan = this.#scans.get(toolCall.id);
		if (scan?.path !== path) scan = this.#track(toolCall.id, path);
		const resolvedPath = scan.resolvedPath;
		if (resolvedPath === undefined || !this.#host.streamingAbortEnabled()) return;

		this.#readIntoCache(resolvedPath);
		if (event.type === "toolcall_start" || scan.ended) return;
		const diff = typeof args.diff === "string" ? args.diff : undefined;
		const op = typeof args.op === "string" ? args.op : undefined;
		if (!diff || (op && op !== "update")) return;
		const rename = typeof args.rename === "string" ? args.rename : undefined;
		this.#checkPatch(scan, resolvedPath, diff, rename, event.type === "toolcall_end");
	}

	/**
	 * Start a scan of `path` for `toolCallId`, replacing any earlier one: a streamed path grows, and
	 * each value it takes is a different file. Runs the auto-generated check on the new target.
	 */
	#track(toolCallId: string, path: string): EditCallScan {
		const scan: EditCallScan = {
			toolCallId,
			path,
			resolvedPath: this.#resolveFsPath(path),
			scannedEnd: 0,
			removed: [],
			verified: 0,
			changed: false,
			ended: false,
		};
		this.#scans.set(toolCallId, scan);
		this.#latestScan = scan;
		if (scan.resolvedPath !== undefined) this.#checkAutoGenerated(scan, scan.resolvedPath);
		return scan;
	}

	#checkAutoGenerated(scan: EditCallScan, resolvedPath: string): void {
		void assertEditableFile(resolvedPath, scan.path).catch(err => {
			// Only a ToolError is an auto-generated verdict; ENOENT and other I/O failures are the
			// edit tool's to report.
			if (!(err instanceof ToolError) || this.#latestScan !== scan) return;
			this.#abort("Streaming edit aborted due to auto-generated file guard", {
				toolCallId: scan.toolCallId,
				path: scan.path,
			});
		});
	}

	#checkPatch(
		scan: EditCallScan,
		resolvedPath: string,
		diff: string,
		rename: string | undefined,
		ended: boolean,
	): void {
		// Mid-stream the last line may be partial, so only complete lines are scanned; once the call
		// has ended the whole diff is.
		const end = ended ? diff.length : diff.lastIndexOf("\n") + 1;
		if (end > scan.scannedEnd && !this.#scan(scan, diff, end)) return;
		if (!scan.changed) return;

		if (scan.removed.length > 0) {
			const content = this.#fileCache.get(resolvedPath);
			if (content !== undefined) {
				this.#verifyRemoved(scan, content);
			} else if (ended) {
				scan.ended = true;
				void this.#verifyRemovedOnDisk(scan, resolvedPath);
			}
			return;
		}
		if (ended) {
			scan.ended = true;
			void this.#previewPatch(scan, diff, rename);
		}
	}

	/**
	 * Scan `diff` from where the last scan stopped up to `end`.
	 *
	 * A removed line is compared with the file on disk, which holds any credential in cleartext, so
	 * its secret placeholders are expanded first. When one cannot be expanded yet this returns false
	 * and the scan stops at that line until the next event: an unexpanded placeholder never matches
	 * the file, and a legitimate edit aborted on it costs more than a check skipped.
	 */
	#scan(scan: EditCallScan, diff: string, end: number): boolean {
		let start = scan.scannedEnd;
		while (start < end) {
			let stop = diff.indexOf("\n", start);
			if (stop < 0 || stop > end) stop = end;
			const line = diff.slice(start, stop).replaceAll("\r", "");
			if (line.startsWith("-") && !line.startsWith("--- ")) {
				const expanded = this.#host.expandSecretsForDiskComparison(line);
				if (expanded === undefined) return false;
				scan.removed.push(expanded.slice(1));
				scan.changed = true;
			} else if (line.startsWith("+") && !line.startsWith("+++ ")) {
				scan.changed = true;
			}
			start = stop + 1;
			scan.scannedEnd = start;
		}
		return true;
	}

	/** Check the removed lines not yet found in `content`; each is looked up once per cached read. */
	#verifyRemoved(scan: EditCallScan, content: string): void {
		const { removed } = scan;
		while (scan.verified < removed.length) {
			const line = removed[scan.verified];
			if (!content.includes(line)) {
				this.#abortForMissingLine(scan, line);
				return;
			}
			scan.verified++;
		}
	}

	async #verifyRemovedOnDisk(scan: EditCallScan, resolvedPath: string): Promise<void> {
		let content: string;
		try {
			content = normalizeToLF(stripBom(await fs.promises.readFile(resolvedPath, "utf-8")).text);
		} catch (err) {
			// A missing or unreadable file is the edit tool's to report.
			if (!isEnoent(err)) {
				logger.debug("Streaming edit check could not read its target", {
					path: scan.path,
					error: errorMessage(err),
				});
			}
			return;
		}
		const missing = scan.removed.find(line => !content.includes(line));
		if (missing !== undefined) this.#abortForMissingLine(scan, missing);
	}

	async #previewPatch(scan: EditCallScan, diff: string, rename: string | undefined): Promise<void> {
		const normalized = normalizeDiff(diff.replaceAll("\r", ""));
		if (!normalized) return;
		const expanded = this.#host.expandSecretsForDiskComparison(normalized);
		if (!expanded) return;
		try {
			await previewPatch(
				{ path: scan.path, op: "update", rename, diff: expanded },
				{ cwd: this.#host.cwd(), ...this.#host.fuzzyMatch() },
			);
		} catch (error) {
			if (error instanceof ParseError) return;
			this.#abort(PREVIEW_FAILURE, { toolCallId: scan.toolCallId, path: scan.path, error: errorMessage(error) });
		}
	}

	#abortForMissingLine(scan: EditCallScan, line: string): void {
		this.#abort(PREVIEW_FAILURE, {
			toolCallId: scan.toolCallId,
			path: scan.path,
			error: `Failed to find expected lines in ${scan.path}:\n${this.#host.redactForLog(line)}`,
		});
	}

	#abort(reason: string, context: Record<string, unknown>): void {
		if (this.#abortTriggered) return;
		this.#abortTriggered = true;
		logger.warn(reason, context);
		this.#host.abortTurn();
	}

	#readIntoCache(resolvedPath: string): void {
		if (this.#fileCache.has(resolvedPath)) return;
		try {
			this.#fileCache.set(resolvedPath, normalizeToLF(stripBom(fs.readFileSync(resolvedPath, "utf-8")).text));
		} catch {
			// Not cached on a read error, ENOENT included: the edit tool reports it.
		}
	}

	/**
	 * Resolve a tool path to a filesystem path: `local://` through the local-protocol handler,
	 * another internal URL to `undefined`, anything else against the session cwd.
	 */
	#resolveFsPath(filePath: string): string | undefined {
		const normalized = normalizeLocalScheme(filePath);
		if (normalized.startsWith("local:")) return resolveLocalUrlToPath(normalized, this.#host.localProtocol());
		if (NON_FILESYSTEM_SCHEMES.some(scheme => normalized.startsWith(scheme))) return undefined;
		return resolveToCwd(normalized, this.#host.cwd());
	}
}
