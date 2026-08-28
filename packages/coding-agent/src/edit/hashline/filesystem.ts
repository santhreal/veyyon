import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	Filesystem,
	NotFoundError,
	type PreflightWriteOptions,
	sameExistingFile,
	type WriteResult,
} from "@veyyon/hashline";
import { atomicWriteFilePreservingMode, isEnoent } from "@veyyon/utils";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../../lsp/client";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { isInternalUrlPath } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath, targetsLocalSandbox } from "../../tools/plan-mode-guard";
import { canonicalSnapshotKey } from "../file-snapshot-store";
import { isNotebookPath } from "../notebook";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { LspBatchRequest } from "../renderer";

export interface HashlineFilesystemOptions {
	session: ToolSession;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
}

export class HashlineFilesystem extends Filesystem {
	readonly session: ToolSession;
	readonly #writethrough: WritethroughCallback;
	readonly #beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
	readonly #signal: AbortSignal | undefined;
	#batchRequest: LspBatchRequest | undefined;
	#diagnosticsByPath = new Map<string, FileDiagnosticsResult | undefined>();

	constructor(options: HashlineFilesystemOptions) {
		super();
		this.session = options.session;
		this.#writethrough = options.writethrough;
		this.#beginDeferredDiagnosticsForPath = options.beginDeferredDiagnosticsForPath;
		this.#signal = options.signal;
		this.#batchRequest = options.batchRequest;
	}

	setBatchRequest(batchRequest: LspBatchRequest | undefined): void {
		this.#batchRequest = batchRequest;
	}

	consumeDiagnostics(path: string): FileDiagnosticsResult | undefined {
		const value = this.#diagnosticsByPath.get(path);
		this.#diagnosticsByPath.delete(path);
		return value;
	}

	resolveAbsolute(relativePath: string): string {
		return resolvePlanPath(this.session, relativePath);
	}

	canonicalPath(relativePath: string): string {
		return canonicalSnapshotKey(this.resolveAbsolute(relativePath));
	}

	allowTagPathRecovery(authoredPath: string, resolvedPath: string): boolean {
		if (isInternalUrlPath(authoredPath)) return false;
		const root = canonicalSnapshotKey(this.session.cwd);
		if (resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`)) return true;
		return targetsLocalSandbox(this.session, resolvedPath);
	}

	async readText(relativePath: string): Promise<string> {
		const absolutePath = this.resolveAbsolute(relativePath);
		let content: string;
		try {
			content = await readEditFileText(absolutePath, relativePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			if (error instanceof Error && error.message === `File not found: ${relativePath}`) {
				throw new NotFoundError(relativePath, error);
			}
			throw error;
		}
		assertEditableFileContent(content, relativePath);
		return content;
	}

	async readBinary(relativePath: string): Promise<Uint8Array | undefined> {
		const absolutePath = this.resolveAbsolute(relativePath);
		if (isNotebookPath(absolutePath)) return undefined;
		try {
			return await fs.readFile(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
	}

	async preflightWrite(relativePath: string, options?: PreflightWriteOptions): Promise<void> {
		const fileOp = options?.fileOp;
		if (fileOp?.kind === "rem") {
			enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
			return;
		}
		if (fileOp?.kind === "move") {
			enforcePlanModeWrite(this.session, relativePath, { op: "update", move: fileOp.dest });
			return;
		}
		enforcePlanModeWrite(this.session, relativePath, { op: "update" });
	}

	async delete(relativePath: string): Promise<void> {
		enforcePlanModeWrite(this.session, relativePath, { op: "delete" });
		const absolutePath = this.resolveAbsolute(relativePath);
		try {
			await fs.rm(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new NotFoundError(relativePath, error);
			throw error;
		}
		if ((this.session.enableLsp ?? true) && this.session.settings.get("lsp.enabled")) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[{ filePath: absolutePath, type: FileChangeType.Deleted }],
				this.#signal,
			);
		}
		invalidateFsScanAfterWrite(absolutePath);
	}

	async move(fromRelative: string, toRelative: string, content?: string): Promise<void> {
		enforcePlanModeWrite(this.session, fromRelative, { op: "update", move: toRelative });
		const fromAbsolute = this.resolveAbsolute(fromRelative);
		const toAbsolute = this.resolveAbsolute(toRelative);
		if (content !== undefined) {
			await atomicWriteFilePreservingMode(toAbsolute, content);
			if (!(await sameExistingFile(fromAbsolute, toAbsolute))) {
				await fs.rm(fromAbsolute);
			}
		} else {
			await fs.rename(fromAbsolute, toAbsolute);
		}
		if ((this.session.enableLsp ?? true) && this.session.settings.get("lsp.enabled")) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[
					{ filePath: fromAbsolute, type: FileChangeType.Deleted },
					{ filePath: toAbsolute, type: FileChangeType.Created },
				],
				this.#signal,
			);
		}
		invalidateFsScanAfterWrite(fromAbsolute);
		invalidateFsScanAfterWrite(toAbsolute);
	}

	async writeText(relativePath: string, content: string): Promise<WriteResult> {
		await this.preflightWrite(relativePath);
		const absolutePath = this.resolveAbsolute(relativePath);
		const finalContent = await serializeEditFileText(absolutePath, relativePath, content);

		if (await routeWriteThroughBridge(this.session, relativePath, absolutePath, finalContent, this.#signal)) {
			this.#diagnosticsByPath.set(relativePath, undefined);
			return { text: finalContent };
		}

		const diagnostics = await this.#writethrough(
			absolutePath,
			finalContent,
			this.#signal,
			Bun.file(absolutePath),
			this.#batchRequest,
			dst => (dst === absolutePath ? this.#beginDeferredDiagnosticsForPath(absolutePath) : undefined),
		);
		invalidateFsScanAfterWrite(absolutePath);
		this.#diagnosticsByPath.set(relativePath, diagnostics);
		return { text: finalContent };
	}

	async exists(relativePath: string): Promise<boolean> {
		const absolutePath = this.resolveAbsolute(relativePath);
		return Bun.file(absolutePath).exists();
	}
}
