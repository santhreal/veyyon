import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { MismatchError as HashlineMismatchError, HL_MOVE_KEYWORD } from "@veyyon/hashline";
import hashlineGrammar from "@veyyon/hashline/grammar.lark" with { type: "text" };
import hashlineDescription from "@veyyon/hashline/prompt.md" with { type: "text" };
import { errorMessage, isCancellation, prompt } from "@veyyon/utils";
import { createLspWritethrough, flushLspWritethroughBatch, type WritethroughCallback, writethroughNoop } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import { PROMPTS } from "../prompts/registry";
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { isInternalUrlPath } from "../tools/path-utils";
import { ToolAbortError } from "../tools/tool-errors";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import { executeHashlineSingle, hashlineEditParamsSchema } from "./hashline";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import { executePatchSingle, type PatchEditEntry, type PatchParams, patchEditSchema } from "./modes/patch";
import { executeReplaceSingle, type ReplaceEditEntry, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type LspBatchRequest } from "./renderer";
import { pruneOversizedEditSnapshots } from "./snapshot-details";
import { EDIT_MODE_STRATEGIES } from "./streaming";

export * from "@veyyon/hashline";
export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./file-snapshot-store";
export * from "./hashline";
export * from "./modes/apply-patch";
export * from "./modes/patch";
// The matching engine moved out of `./modes/replace` to break a cycle with
// `./diff`; re-exported here so the barrel surface is unchanged.
export * from "./match";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";
export * from "./snapshot-details";
export * from "./streaming";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema;

type HashlineParams = typeof hashlineEditParamsSchema.infer;

type EditParams = ReplaceParams | PatchParams | HashlineParams | ApplyPatchParams;

type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	examples?: readonly ToolExample[];
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolDetails, TInput>>;
};

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid VEYYON_EDIT_VARIANT: ${rawEditMode}`);
	}

	return editMode;
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid VEYYON_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid VEYYON_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
	return enableLsp
		? createLspWritethrough(session.cwd, {
				enableFormat,
				enableDiagnostics,
				transformDiagnostics: dedup
					? (path, result) => getDiagnosticsLedger(session).reduce(path, result)
					: undefined,
			})
		: writethroughNoop;
}

/**
 * The error a multi-step edit throws when it is cancelled partway through.
 *
 * A multi-step edit is the one place where "was it aborted" and "what happened
 * to my files" are the same question. Both loops below used to fold an abort
 * into the ordinary error result, which lost two things at once. The caller
 * could not tell a cancellation from a failed match, so the agent loop treated
 * an interrupted edit as a mistake worth retrying rather than as the operator
 * saying stop. And the partial-application summary, which is the only record of
 * which files were already rewritten, was reachable only by reading the result
 * text of something that looked like an ordinary failure.
 *
 * So the abort keeps its type AND carries the summary in its message. One
 * helper, because the per-file loop and the per-entry loop must not word this
 * differently: an operator reading the two should not have to work out whether
 * they mean the same thing.
 *
 * It stays local rather than moving to `tools/tool-errors.ts`. The eval tool has
 * the same defect and the same fix, but its `cells` array is always exactly one
 * element, so an "N of M, these ran and these did not" summary would describe a
 * sequence it never has. A shared helper would have to be told that, and would
 * be a worse home for both wordings than each tool saying its own plainly.
 */
function abortedPartway(
	unit: "file" | "entry",
	applied: readonly string[],
	pending: readonly string[],
	cause: unknown,
) {
	const total = applied.length + pending.length;
	// Spelled out rather than suffixed: `entry` + "s" is `entrys`, and a message
	// that exists to be read at the worst moment of a session cannot be the place
	// a reader trips over a typo.
	const plural = unit === "file" ? "files" : "entries";
	const parts = [`Edit cancelled after ${applied.length} of ${total} ${total === 1 ? unit : plural}`];
	if (applied.length > 0) parts.push(`already applied: ${applied.join(", ")}`);
	if (pending.length > 0) parts.push(`NOT applied: ${pending.join(", ")}`);
	parts.push("re-read the affected files before re-issuing");
	return new ToolAbortError(parts.join("; "), { cause });
}

/**
 * Finalize the files a cancelled multi-step edit already wrote.
 *
 * Deliberately flushes WITHOUT the signal. The batch holds files that are
 * already on disk, and flushing is what finalizes them; passing the signal that
 * just fired would abort the flush and leave them in an unfinalized batch, which
 * is the state this call exists to prevent.
 */
async function flushAfterAbort(batchRequest: LspBatchRequest | undefined, cwd: string): Promise<void> {
	if (!batchRequest?.flush) return;
	await flushLspWritethroughBatch(batchRequest.id, cwd);
}

/** Run apply_patch file operations and aggregate their multi-file result. */
async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let hasError = false;

	const filePaths = fileEntries.map(entry => entry.path);
	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		// Do not START another file once the operator has cancelled. Without this
		// the loop relied on the innermost atomic write noticing the signal, which
		// covers a content rewrite and nothing else: a delete or a move in the same
		// patch does not go through that path and would have been carried out after
		// the cancellation.
		if (signal?.aborted) {
			await flushAfterAbort(outerBatchRequest, cwd);
			throw abortedPartway("file", filePaths.slice(0, i), filePaths.slice(i), signal.reason);
		}
		const isLast = i === fileEntries.length - 1;
		// Per-file writes join the outer LSP write batch; only the last entry
		// flushes it, so cross-file writes coalesce into a single
		// format+diagnostics pass. The failure path below flushes explicitly
		// when the loop stops early.
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				sourcePath: details?.sourcePath,
				meta: details?.meta,
				oldText: details?.oldText,
				newText: details?.newText,
				snapshotsPruned: details?.snapshotsPruned,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			// A cancellation is not an edit failure and must not be reported as
			// one: the caller has to be able to stop rather than re-issue. The
			// applied/skipped summary travels in the abort's message so nothing is
			// lost by keeping the type.
			if (isCancellation(err)) {
				await flushAfterAbort(outerBatchRequest, cwd);
				throw abortedPartway("file", filePaths.slice(0, i), filePaths.slice(i), err);
			}
			const errorText = errorMessage(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			hasError = true;
			// Later entries were authored assuming this file's post-state; a
			// partial cascade after failure typically compounds damage. Stop
			// here, report applied vs. skipped, and let the caller re-issue
			// only the failed and unapplied files. Matches
			// `executeSinglePathEntries` semantics.
			if (i > 0) {
				const appliedPaths = fileEntries
					.slice(0, i)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(`Files already applied: ${appliedPaths}.`);
			}
			if (i + 1 < fileEntries.length) {
				const skippedPaths = fileEntries
					.slice(i + 1)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(
					`Files NOT applied: ${skippedPaths}; re-read the affected files and re-issue only the failed and unapplied files.`,
				);
			}
			// Stopping early skips the last-entry flush above; finalize the
			// already-written files so an intervening failure cannot leave them
			// sitting in an unfinalized LSP write batch (mirrors the delete-path
			// flush in executePatchSingle).
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		}),
		// Any per-file failure marks the aggregate result as an error so the
		// agent loop and renderer take the error branch instead of treating
		// a mixed partial application as a successful edit.
		...(hasError ? { isError: true } : {}),
	};
}

async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate: ((partialResult: AgentToolResult<EditToolDetails, TInput>) => void) | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let hasError = false;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;
	// Any pruned child invalidates the aggregate snapshot: combining a kept
	// first-entry oldText with a pruned next entry's newText (or vice-versa)
	// would describe a transition the file never made. Suppress aggregate
	// snapshots and stamp the marker so ACP/downstream can degrade cleanly.
	let snapshotsPruned = false;

	// Entries are numbered rather than named: they all target the same path, so a
	// list of paths would say the same thing `runs.length` times.
	const entryLabels = runs.map((_, index) => `entry ${index + 1}`);
	for (let i = 0; i < runs.length; i++) {
		// Same reason as the per-file loop: stop before starting the next entry,
		// rather than trusting the innermost write to refuse.
		if (signal?.aborted) {
			await flushAfterAbort(outerBatchRequest, cwd);
			throw abortedPartway("entry", entryLabels.slice(0, i), entryLabels.slice(i), signal.reason);
		}
		const isLast = i === runs.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await runs[i](batchRequest);
			const details = result.details;
			if (details?.diff) diffTexts.push(details.diff);
			firstChangedLine ??= details?.firstChangedLine;
			if (details?.path) {
				metadataPath ??= details.path;
			}
			if (details && "oldText" in details && !hasFirstOldText) {
				firstOldText = details.oldText;
				hasFirstOldText = true;
			}
			if (details && "newText" in details) {
				lastNewText = details.newText;
				hasLastNewText = true;
			}
			if (details?.snapshotsPruned) snapshotsPruned = true;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			if (isCancellation(err)) {
				await flushAfterAbort(outerBatchRequest, cwd);
				throw abortedPartway("entry", entryLabels.slice(0, i), entryLabels.slice(i), err);
			}
			const errorText = errorMessage(err);
			contentTexts.push(`Error editing ${path} (entry ${i + 1} of ${runs.length}): ${errorText}`);
			if (i > 0) {
				contentTexts.push(i === 1 ? `Entry 1 was already applied.` : `Entries 1-${i} were already applied.`);
			}
			if (i + 1 < runs.length) {
				contentTexts.push(
					(i + 2 === runs.length
						? `Entry ${runs.length} was NOT applied`
						: `Entries ${i + 2}-${runs.length} were NOT applied`) +
						`; re-read the file and re-issue only the failed and unapplied entries.`,
				);
			}
			hasError = true;
			// Stop at the first failure: later entries were authored against
			// line numbers/content that assumed this entry succeeded, and
			// applying them after a failure compounds the damage.
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: diffTexts.join("\n"),
					firstChangedLine,
				},
				...(hasError ? { isError: true } : {}),
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(snapshotsPruned
				? { snapshotsPruned: true as const }
				: {
						...(hasFirstOldText ? { oldText: firstOldText } : {}),
						...(hasLastNewText ? { newText: lastNewText } : {}),
					}),
		}),
		// Any per-entry failure marks the aggregate result as an error so the
		// renderer takes the error branch instead of falling through to the
		// streaming-edit preview (which displays the *proposed* diff and looks
		// indistinguishable from success).
		...(hasError ? { isError: true } : {}),
	};
}

function extractApprovalPath(args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		const hashlineMatch = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
		if (hashlineMatch?.[1]) return hashlineMatch[1];

		const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
		if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
	}

	const targetPath = record.path;
	return typeof targetPath === "string" && targetPath.length > 0 ? targetPath : "(unknown)";
}

/**
 * Every real filesystem path an edit call would touch, for the cwd boundary
 * (see cwd-boundary.ts). Unlike {@link extractApprovalPath} (which returns a
 * single display path), this collects ALL targets: the `path` arg plus every
 * file named by an apply-patch body (`*** Add|Update|Delete File:`), since one
 * apply-patch call can mutate several files. Hashline `[path#TAG]` wrappers are
 * unwrapped so they cannot dodge the boundary. A move/rename DESTINATION is
 * collected too (both formats can move: the apply-patch `*** Move to: <dest>`
 * and the hashline `MV <dest>` line), because a move writes the file to a NEW
 * path that may escape cwd even when the source file is inside it. Selector/
 * scheme filtering is left to the boundary.
 */
export function editFilesystemTargets(args: unknown): string[] {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const targets: string[] = [];
	if (typeof record.path === "string" && record.path.length > 0) targets.push(record.path);
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		for (const match of input.matchAll(/^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/gm)) {
			if (match[1]) targets.push(match[1]);
		}
		for (const match of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
			if (match[1]) targets.push(match[1].trim());
		}
		// Move/rename destinations. Over-matching only over-prompts (fail-closed);
		// missing one would let an out-of-cwd move dodge the boundary.
		for (const match of input.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) {
			if (match[1]) targets.push(match[1].trim());
		}
		for (const match of input.matchAll(new RegExp(String.raw`^\s*${HL_MOVE_KEYWORD}\s+(.+)$`, "gm"))) {
			if (match[1]) targets.push(match[1].trim());
		}
	}
	return targets;
}

export class EditTool implements AgentTool<TInput> {
	readonly approval = (args: unknown) => {
		const targetPath = extractApprovalPath(args);
		return targetPath !== "(unknown)" && isInternalUrlPath(targetPath) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => [
		`File: ${truncateForPrompt(extractApprovalPath(args))}`,
	];
	// The cwd boundary gates out-of-cwd edits in non-yolo modes; an apply-patch
	// body can touch several files, so all are reported. See cwd-boundary.ts.
	readonly filesystemTargets = (args: unknown): string[] => editFilesystemTargets(args);
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #deferredDiagnostics: DeferredDiagnostics;

	constructor(private readonly session: ToolSession) {
		const {
			VEYYON_EDIT_FUZZY: editFuzzy = "auto",
			VEYYON_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			VEYYON_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		const deduplicateDiagnostics =
			(session.enableLsp ?? true) &&
			session.settings.get("lsp.diagnosticsOnEdit") &&
			session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics = new DeferredDiagnostics(session, deduplicateDiagnostics);
		this.#writethrough = createEditWritethrough(session);
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	get examples(): readonly ToolExample[] | undefined {
		return this.#getModeDefinition().examples;
	}

	/**
	 * When in `apply_patch` mode, expose the Codex Lark grammar so providers
	 * that support OpenAI-style custom tools can emit a grammar-constrained
	 * variant. Providers that don't support custom tools ignore this field
	 * and fall back to emitting a JSON function tool from `parameters`.
	 */
	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode === "apply_patch") return { syntax: "lark", definition: applyPatchGrammar };
		if (this.mode === "hashline") return { syntax: "lark", definition: hashlineGrammar };
		return undefined;
	}

	/**
	 * Wire-level tool name used when the custom-tool variant is active. GPT-5+
	 * is trained on the literal name `apply_patch`; internally this is just a
	 * mode of the `edit` tool. The agent-loop dispatcher matches both the
	 * internal `name` and `customWireName`, so returned calls route correctly.
	 */
	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	/**
	 * Normalize streamed args into the source text this edit introduces, so
	 * stream matchers (TTSR rules) run against real file content instead of the
	 * mode-specific patch grammar.
	 */
	matcherDigest(args: unknown): string | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherDigest(args);
	}

	/**
	 * Project the streamed args onto their target file paths so path-scoped
	 * stream matchers (e.g. TTSR `tool:edit(*.ts)` globs) match hashline and
	 * apply_patch edits even though the path lives in the wire payload (a
	 * section header / envelope marker) rather than a top-level argument.
	 */
	matcherPaths(args: unknown): readonly string[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherPaths(args);
	}

	/**
	 * Per-file projection of the streamed args, splitting multi-section
	 * hashline / multi-hunk apply_patch payloads into one (path, digest) entry
	 * per touched file. Path-scoped stream matchers (TTSR) then evaluate each
	 * file in isolation, so a `tool:edit(*.ts)` rule never fires on text that
	 * actually belongs to a sibling Markdown hunk.
	 */
	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherEntries(args);
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			patch: {
				description: () => prompt.render(PROMPTS["tools/patch"].text),
				parameters: patchEditSchema,
				examples: [
					{
						caption: "Create",
						call: { path: "hello.txt", edits: [{ op: "create", diff: "Hello\n" }] },
					},
					{
						caption: "Update",
						call: {
							path: "src/app.py",
							edits: [
								{
									op: "update",
									diff: "@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n",
								},
							],
						},
					},
					{
						caption: "Rename",
						call: {
							path: "src/app.py",
							edits: [{ op: "update", rename: "src/main.py", diff: "@@\n …\n" }],
						},
					},
					{
						caption: "Delete",
						call: { path: "obsolete.txt", edits: [{ op: "delete" }] },
					},
					{
						caption: "Multiple entries",
						note: "All entries in one call apply to the top-level `path`; use separate calls for different files.",
					},
				] satisfies readonly ToolExample<PatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as PatchParams;
					const runs = (edits as PatchEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								// The JSON grammar has no `*** Update File`; its `op: "create"`
								// doubles as the documented full-file overwrite (patch.md <avoid>).
								allowCreateOverwrite: true,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate, tool.session.cwd, signal);
				},
			},
			apply_patch: {
				description: () => prompt.render(PROMPTS["tools/apply-patch"].text),
				parameters: applyPatchSchema,
				examples: [
					{
						caption: "Apply a combined patch file",
						call: {
							input: '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n',
						},
					},
				] satisfies readonly ToolExample<ApplyPatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: (br: LspBatchRequest | undefined) =>
								executePatchSingle({
									session: tool.session,
									path,
									params: patchParams,
									signal,
									batchRequest: br,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
									writethrough: tool.#writethrough,
									beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
								}),
						};
					});
					return executeApplyPatchPerFile(perFile, batchRequest, tool.session.cwd, signal, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(hashlineDescription),
				parameters: hashlineEditParamsSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input } = params as HashlineParams;
					return executeHashlineSingle({
						session: tool.session,
						input,
						signal,
						batchRequest,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
					});
				},
			},
			replace: {
				description: () => prompt.render(PROMPTS["tools/replace"].text),
				parameters: replaceEditSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as ReplaceParams;
					const runs = (edits as ReplaceEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executeReplaceSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate, tool.session.cwd, signal);
				},
			},
		}[this.mode];
	}
}
