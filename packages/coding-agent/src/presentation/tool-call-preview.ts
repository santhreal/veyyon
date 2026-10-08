import type { SnapshotStore } from "@veyyon/hashline";
import { logger } from "@veyyon/utils";
import { EDIT_MODE_STRATEGIES, type PerFileDiffPreview } from "../edit/streaming";
import type { EditMode } from "../utils/edit-mode";

/** What a preview notifies when a computed diff preview lands. */
export interface ToolCallPreviewListener {
	toolCallPreviewChanged(): void;
}

export interface ToolCallPreviewOptions {
	toolName: string;
	mode?: EditMode;
	cwd: string;
	snapshots?: SnapshotStore;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	/** An object rather than a callback, so the producer that owns a preview listens without a closure per card. */
	listener: ToolCallPreviewListener;
}

export function isEditLikeToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "apply_patch";
}

function partialJsonOf(args: unknown): string | undefined {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	return typeof args.__partialJson === "string" ? args.__partialJson : undefined;
}

function streamedArguments(args: unknown): unknown {
	if (args == null || typeof args !== "object") return args;
	if ("input" in args && typeof args.input === "string") return args;
	const partialJson = partialJsonOf(args);
	const trimmed = partialJson?.trimStart();
	if (!trimmed || trimmed[0] === "{" || trimmed[0] === '"') return args;
	return { ...args, input: partialJson };
}

/** Hide an incomplete removal hunk until its added lines arrive. */
function stabilizePreviews(previews: PerFileDiffPreview[]): PerFileDiffPreview[] {
	let changed = false;
	const next = previews.map(preview => {
		if (!preview.diff) return preview;
		const lines = preview.diff.split("\n");
		let lastAdd = lines.length - 1;
		while (lastAdd >= 0 && !lines[lastAdd].startsWith("+")) lastAdd--;
		let incomplete = false;
		for (let index = lastAdd + 1; index < lines.length; index++) {
			if (lines[index].startsWith("-") || lines[index].startsWith("@@")) {
				incomplete = true;
				break;
			}
		}
		if (!incomplete) return preview;
		changed = true;
		return { ...preview, diff: lastAdd === -1 ? "" : lines.slice(0, lastAdd + 1).join("\n") };
	});
	return changed ? next : previews;
}

/** Single-flight preview computation shared by presentation producers. */
export class ToolCallPreview {
	#args: unknown;
	complete = false;
	#previews?: PerFileDiffPreview[];
	#lastKey?: string;
	#abort?: AbortController;
	#inFlight?: Promise<void>;
	#dirty = false;
	#settled = false;

	constructor(
		args: unknown,
		readonly options: ToolCallPreviewOptions,
	) {
		this.#args = args;
	}

	get arguments(): unknown {
		const args = streamedArguments(this.#args);
		if (!isEditLikeToolName(this.options.toolName)) return args;
		const projected: Record<string, unknown> = { ...(args as Record<string, unknown>) };
		if (this.options.mode) projected.editMode = this.options.mode;
		const previews = this.#previews;
		if (!previews?.length) return projected;
		const first = previews[0];
		if (first.error) projected.preview = { error: first.error };
		else if (first.diff) {
			projected.previewDiff = first.diff;
			projected.preview = { diff: first.diff, firstChangedLine: first.firstChangedLine };
		}
		if (previews.length > 1) projected.previewFiles = previews;
		return projected;
	}

	update(args: unknown): void {
		this.#args = args;
		if (!this.options.mode || this.#settled) return;
		this.#dirty = true;
		if (this.#inFlight) return;
		this.#inFlight = this.#drain().finally(() => {
			this.#inFlight = undefined;
		});
	}

	async whenSettled(): Promise<void> {
		await this.#inFlight;
	}

	stop(): void {
		this.#abort?.abort();
		this.#abort = undefined;
		this.#dirty = false;
	}

	/**
	 * The call has its final result, which a card draws in place of the preview: compute nothing
	 * more. A preview already computed stays readable.
	 */
	settle(): void {
		this.#settled = true;
		this.stop();
	}

	async #drain(): Promise<void> {
		// Start on the next microtask, so a call that gets its result in the same task computes
		// nothing: a transcript rebuilt from history hands every card its call and then its result.
		await undefined;
		while (this.#dirty) {
			this.#dirty = false;
			await this.#compute();
		}
	}

	async #compute(): Promise<void> {
		const mode = this.options.mode;
		if (!mode) return;
		const strategy = EDIT_MODE_STRATEGIES[mode];
		if (!strategy || this.#args == null || typeof this.#args !== "object") return;
		if (mode === "hashline" && !this.options.snapshots) return;
		const previewArgs = streamedArguments(this.#args);
		const partialJson = partialJsonOf(previewArgs);
		let effectiveArgs: unknown;
		try {
			effectiveArgs = strategy.extractCompleteEdits(previewArgs, partialJson);
		} catch {
			effectiveArgs = previewArgs;
		}
		const streamingState = this.complete ? "final" : "stream";
		let key: string;
		try {
			key = `${streamingState}:${Bun.hash(JSON.stringify(effectiveArgs))}`;
		} catch {
			key = `${streamingState}:partial:${Bun.hash(partialJson ?? "")}`;
		}
		if (key === this.#lastKey) return;
		this.#lastKey = key;
		const controller = new AbortController();
		this.#abort = controller;
		try {
			const isStreaming = !this.complete;
			const previews = await strategy.computeDiffPreview(effectiveArgs, {
				cwd: this.options.cwd,
				signal: controller.signal,
				snapshots: this.options.snapshots!,
				fuzzyThreshold: this.options.fuzzyThreshold,
				allowFuzzy: this.options.allowFuzzy,
				isStreaming,
			});
			if (controller.signal.aborted || !previews) return;
			this.#previews = isStreaming ? stabilizePreviews(previews) : previews;
			this.options.listener.toolCallPreviewChanged();
		} catch (error) {
			if (!controller.signal.aborted) {
				logger.warn("Edit preview diff failed", { tool: this.options.toolName, error: String(error) });
			}
		} finally {
			// A finished computation has nothing left to abort, and the card holding this preview outlives it.
			if (this.#abort === controller) this.#abort = undefined;
		}
	}
}
