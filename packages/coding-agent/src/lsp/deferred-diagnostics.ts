import type { DeferredDiagnosticsEntry, ToolSession } from "../tools";
import { getDiagnosticsLedger } from "./diagnostics-ledger";
import type { FileDiagnosticsResult, WritethroughDeferredHandle } from "./index";

/** Coordinates late LSP diagnostics for one mutation tool instance. */
export class DeferredDiagnostics {
	readonly #pendingFetches = new Map<string, AbortController>();
	readonly #fallbackVersions = new Map<string, number>();

	constructor(
		private readonly session: ToolSession,
		private readonly deduplicate: boolean,
	) {}

	/** Begin a file mutation and return the handle consumed by LSP writethrough. */
	begin(path: string): WritethroughDeferredHandle {
		this.#pendingFetches.get(path)?.abort();

		const controller = new AbortController();
		// Registered here rather than in `finalize(undefined)`. A second begin before the first
		// finalize used to find nothing to abort, so the first LSP round-trip kept running and
		// returned a snapshot of a file that had already been mutated again.
		this.#pendingFetches.set(path, controller);
		const mutationVersion = this.#bumpVersion(path);
		return {
			onDeferredDiagnostics: diagnostics => {
				this.#release(path, controller);
				this.#inject(path, diagnostics, mutationVersion);
			},
			signal: controller.signal,
			finalize: diagnostics => {
				if (!diagnostics) return;
				this.#release(path, controller);
				controller.abort();
			},
		};
	}

	/** Forget `controller` unless a later `begin` already replaced it as the live one for `path`. */
	#release(path: string, controller: AbortController): void {
		if (this.#pendingFetches.get(path) === controller) this.#pendingFetches.delete(path);
	}

	#inject(path: string, diagnostics: FileDiagnosticsResult, mutationVersion: number): void {
		const effective = this.deduplicate ? getDiagnosticsLedger(this.session).reduce(path, diagnostics) : diagnostics;
		if (this.deduplicate && effective.messages.length === 0) return;

		const entry: DeferredDiagnosticsEntry = {
			path,
			summary: effective.summary ?? "",
			messages: effective.messages ?? [],
			errored: effective.errored,
			isStale: () => this.#version(path) !== mutationVersion,
		};
		this.session.queueDeferredDiagnostics?.(entry);
	}

	#bumpVersion(path: string): number {
		if (this.session.bumpFileMutationVersion) return this.session.bumpFileMutationVersion(path);
		const next = (this.#fallbackVersions.get(path) ?? 0) + 1;
		this.#fallbackVersions.set(path, next);
		return next;
	}

	#version(path: string): number {
		if (this.session.getFileMutationVersion) return this.session.getFileMutationVersion(path);
		return this.#fallbackVersions.get(path) ?? 0;
	}
}
