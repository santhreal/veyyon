import type { Component } from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import type { CacheInvalidation } from "./cache-invalidation-marker-helpers";
import { renderTranscriptDivider } from "./transcript-divider";

export { detectCacheInvalidation, usesExplicitPromptCache } from "./cache-invalidation-marker-helpers";
export type { CacheInvalidation };

export class CacheInvalidationMarkerComponent implements Component {
	#cache?: { width: number; lines: string[] };

	constructor(private readonly info: CacheInvalidation) {}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const icon = theme.icon.cacheMiss;
		const name = this.info.rejected ? "cache rejected" : "cache miss";
		const head = icon ? `${icon} ${name}` : name;
		const tokens = this.info.reprocessedTokens;
		const dot = theme.sep.dot.trim();
		const parts = [head];
		if (tokens > 0) parts.push(`${formatNumber(tokens)} tokens`);
		if (this.info.cause) parts.push(this.info.cause);
		return renderTranscriptDivider(width, parts.join(` ${dot} `));
	}
}
