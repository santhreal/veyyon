/**
 * The edit tool's write path for the patch engine: plan-mode and generated-file checks, the write through
 * the ACP bridge or the LSP writethrough, post-write verification, and the result the tool returns.
 *
 * `./patch` holds the engine alone, which the streaming edit guard previews on every session; this module
 * is reached from the edit tool, so the LSP client and the ACP bridge load with the first edit.
 */
import * as fs from "node:fs";
import type { AgentToolResult } from "@veyyon/agent-core";
import { isEnoent } from "@veyyon/utils";
import {
	type FileDiagnosticsResult,
	flushLspWritethroughBatch,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
} from "../../lsp";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../../lsp/client";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/core/acp-bridge";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../../tools/core/fs-cache-invalidation";
import { outputMeta } from "../../tools/core/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/core/plan-mode-guard";
import type { LspBatchRequest } from "../../tools/core/render-utils";
import { ToolError } from "../../tools/core/tool-errors";
import { assertEditableFile } from "../../tools/fs/auto-generated-guard";
import type { EditToolDetails } from "../details";
import { generateUnifiedDiffString } from "../diff";
import { normalizeToLF, stripBom } from "../normalize";
import { readEditFileText, serializeEditFileText } from "../read-file";
import { pruneOversizedEditSnapshots } from "../snapshot-details";
import {
	applyPatch,
	type FileSystem,
	type Operation,
	type PatchEditEntry,
	type PatchInput,
	type patchEditEntrySchema,
} from "./patch";

export interface ExecutePatchSingleOptions {
	session: ToolSession;
	path: string;
	params: PatchEditEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	/** `ApplyPatchOptions.allowCreateOverwrite` in `./patch`; set by the JSON `patch` mode only. */
	allowCreateOverwrite?: boolean;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

class LspFileSystem implements FileSystem {
	#lastDiagnostics: FileDiagnosticsResult | undefined;
	#fileCache: Record<string, Bun.BunFile> = {};

	constructor(
		private readonly session: ToolSession,
		private readonly requestedPath: string,
		private readonly writethrough: WritethroughCallback,
		private readonly signal?: AbortSignal,
		private readonly batchRequest?: LspBatchRequest,
		private readonly deferredForPath?: (path: string) => WritethroughDeferredHandle,
	) {}

	#getFile(path: string): Bun.BunFile {
		if (this.#fileCache[path]) {
			return this.#fileCache[path];
		}
		const file = Bun.file(path);
		this.#fileCache[path] = file;
		return file;
	}

	async exists(path: string): Promise<boolean> {
		return this.#getFile(path).exists();
	}

	async read(path: string): Promise<string> {
		return readEditFileText(path, path);
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const bytes = await fs.promises.readFile(path);
		return bytes;
	}

	async write(path: string, content: string): Promise<void> {
		const finalContent = await serializeEditFileText(path, path, content);

		// Route through ACP bridge when available; skips internal artifacts and local:// paths.
		if (await routeWriteThroughBridge(this.session, this.requestedPath, path, finalContent, this.signal)) {
			return;
		}

		const file = this.#getFile(path);
		const deferredForPath = this.deferredForPath;
		const result = await this.writethrough(
			path,
			finalContent,
			this.signal,
			file,
			this.batchRequest,
			deferredForPath ? (dst: string) => deferredForPath(dst) : undefined,
		);
		if (result) {
			this.#lastDiagnostics = result;
		}
	}

	async delete(path: string): Promise<void> {
		await this.#getFile(path).unlink();
		if ((this.session.enableLsp ?? true) && this.session.settings.get("lsp.enabled")) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[{ filePath: path, type: FileChangeType.Deleted }],
				this.signal,
			);
		}
	}

	async mkdir(path: string): Promise<void> {
		await fs.promises.mkdir(path, { recursive: true });
	}

	getDiagnostics(): FileDiagnosticsResult | undefined {
		return this.#lastDiagnostics;
	}
}

function mergeDiagnosticsWithWarnings(
	diagnostics: FileDiagnosticsResult | undefined,
	warnings: string[],
): FileDiagnosticsResult | undefined {
	if (warnings.length === 0) return diagnostics;
	const warningMessages = warnings.map(warning => `patch: ${warning}`);
	if (!diagnostics) {
		return {
			server: "patch",
			messages: warningMessages,
			summary: `Patch warnings: ${warnings.length}`,
			errored: false,
		};
	}
	return {
		...diagnostics,
		messages: warningMessages.concat(diagnostics.messages),
		summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
	};
}

export async function executePatchSingle(
	options: ExecutePatchSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof patchEditEntrySchema.value>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		allowCreateOverwrite,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;
	const { op: rawOp, rename, diff } = params;

	const op: Operation = rawOp === "create" || rawOp === "delete" ? rawOp : "update";

	enforcePlanModeWrite(session, path, { op, move: rename });
	const resolvedPath = resolvePlanPath(session, path);
	const resolvedRename = rename ? resolvePlanPath(session, rename) : undefined;

	await assertEditableFile(resolvedPath, path);

	// Capture pre-edit content so we can verify the write actually hit disk.
	// `LspFileSystem.writeFile` delegates to a writethrough callback that, in
	// some host integrations, has been observed to report success without
	// persisting bytes — leaving the tool to claim "Updated <path>" while the
	// file on disk is byte-identical to before. After the write we re-read
	// the file and assert the bytes match the expected newContent; relying
	// on stat (mtime/size) is unreliable because filesystems with coarse
	// timestamp resolution can record an unchanged mtime even when the
	// content was rewritten, and same-length rewrites leave size unchanged.
	let preEditContent: Uint8Array | undefined;
	if (op === "update") {
		try {
			preEditContent = await fs.promises.readFile(resolvedPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	const input: PatchInput = { path: resolvedPath, op, rename: resolvedRename, diff };
	const patchFileSystem = new LspFileSystem(
		session,
		path, // original user-provided path for bridge guard (may be local://, vault://, etc.)
		writethrough,
		signal,
		batchRequest,
		beginDeferredDiagnosticsForPath,
	);
	const result = await applyPatch(input, {
		cwd: session.cwd,
		fs: patchFileSystem,
		fuzzyThreshold,
		allowFuzzy,
		allowCreateOverwrite,
	});

	// Post-write verification: only meaningful for in-place updates where the
	// patch actually changes content and the file is not being renamed away.
	if (
		result.change.type === "update" &&
		!result.change.newPath &&
		preEditContent !== undefined &&
		result.change.oldContent !== undefined &&
		result.change.newContent !== undefined &&
		result.change.oldContent !== result.change.newContent
	) {
		let postEditContent: Uint8Array | undefined;
		try {
			postEditContent = await fs.promises.readFile(resolvedPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const unchanged =
			postEditContent !== undefined &&
			postEditContent.length === preEditContent.length &&
			postEditContent.every((b, i) => b === preEditContent[i]);
		if (unchanged) {
			throw new ToolError(`edit appeared successful but file content did not change on disk: ${path}`, {
				path: resolvedPath,
			});
		}
	}

	if (resolvedRename) {
		invalidateFsScanAfterRename(resolvedPath, resolvedRename);
	} else if (result.change.type === "delete") {
		invalidateFsScanAfterDelete(resolvedPath);
	} else {
		invalidateFsScanAfterWrite(resolvedPath);
	}
	const effectiveRename = result.change.newPath ? rename : undefined;

	let diffResult: { diff: string; firstChangedLine: number | undefined } = {
		diff: "",
		firstChangedLine: undefined,
	};
	if (
		result.change.type === "update" &&
		result.change.oldContent !== undefined &&
		result.change.newContent !== undefined
	) {
		const normalizedOld = normalizeToLF(stripBom(result.change.oldContent).text);
		const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text);
		diffResult = generateUnifiedDiffString(normalizedOld, normalizedNew, undefined, {
			path: result.change.newPath ?? result.change.path,
		});
	} else if (result.change.type === "create" && result.change.newContent !== undefined) {
		// The result is authoritative for rendering, so emit the added-content
		// diff here rather than relying on the call-phase streaming preview.
		const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text);
		diffResult = generateUnifiedDiffString("", normalizedNew, undefined, { path: result.change.path });
	}

	let resultText: string;
	switch (result.change.type) {
		case "create":
			resultText = `Created ${path}`;
			break;
		case "delete":
			resultText = `Deleted ${path}`;
			break;
		case "update":
			resultText = effectiveRename ? `Updated and moved ${path} to ${effectiveRename}` : `Updated ${path}`;
			break;
	}

	let diagnostics = patchFileSystem.getDiagnostics();
	if (op === "delete" && batchRequest?.flush) {
		const flushedDiagnostics = await flushLspWritethroughBatch(batchRequest.id, session.cwd, signal);
		diagnostics ??= flushedDiagnostics;
	}
	const mergedDiagnostics = mergeDiagnosticsWithWarnings(diagnostics, result.warnings ?? []);
	const meta = outputMeta()
		.diagnostics(mergedDiagnostics?.summary ?? "", mergedDiagnostics?.messages ?? [])
		.get();

	const oldText = result.change.type !== "create" ? result.change.oldContent : undefined;
	const newText = result.change.type !== "delete" ? result.change.newContent : undefined;

	return {
		content: [{ type: "text", text: resultText }],
		details: pruneOversizedEditSnapshots({
			diff: diffResult.diff,
			// When the patch moves the file, anchor the diff to the destination
			// path. ACP `ToolCallContent.diff.path` comes from this field, and
			// clients use it to open or focus the file post-change; pointing at
			// the (now-deleted) source navigates to nothing.
			path: result.change.newPath ?? resolvedPath,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics: mergedDiagnostics,
			op,
			move: effectiveRename,
			sourcePath: result.change.newPath ? resolvedPath : undefined,
			meta,
			oldText,
			newText,
		}),
	};
}
