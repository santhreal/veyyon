import { padding, visibleWidth } from "@veyyon/tui";
import type { Theme, ThemeBg } from "../modes/theme/theme";
import type { State } from "./types";

export { Ellipsis, truncateToWidth } from "@veyyon/tui";

const hashBuf = new ArrayBuffer(8);
const hashView = new DataView(hashBuf);
const hashBytes1 = new Uint8Array(hashBuf, 0, 1);
const hashBytes4 = new Uint8Array(hashBuf, 0, 4);
const hashBytes8 = new Uint8Array(hashBuf, 0, 8);

export class Hasher {
	#h = 0n;

	str(s: string): this {
		hashView.setUint32(0, s.length);
		this.#h = Bun.hash.xxHash64(hashBytes4, this.#h);
		this.#h = Bun.hash.xxHash64(s, this.#h);
		return this;
	}

	u32(n: number): this {
		hashView.setUint32(0, n);
		this.#h = Bun.hash.xxHash64(hashBytes4, this.#h);
		return this;
	}

	u64(n: bigint): this {
		hashView.setBigUint64(0, n);
		this.#h = Bun.hash.xxHash64(hashBytes8, this.#h);
		return this;
	}

	bool(b: boolean): this {
		hashView.setUint8(0, b ? 1 : 0);
		this.#h = Bun.hash.xxHash64(hashBytes1, this.#h);
		return this;
	}

	optional(v: string | undefined | null): this {
		if (v == null) {
			hashView.setUint8(0, 0xff);
			this.#h = Bun.hash.xxHash64(hashBytes1, this.#h);
		} else {
			this.#h = Bun.hash.xxHash64(v, this.#h);
		}
		return this;
	}

	digest(): bigint {
		return this.#h;
	}
}

export interface RenderCache {
	key: bigint;
	lines: string[];
}

export function buildTreePrefix(ancestors: readonly boolean[], theme: Theme): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

export function getTreeBranch(isLast: boolean, theme: Theme): string {
	return isLast ? theme.tree.last : theme.tree.branch;
}

export function getTreeContinuePrefix(isLast: boolean, theme: Theme): string {
	return isLast ? "   " : `${theme.tree.vertical}  `;
}

export function padToWidth(text: string, width: number, bgFn?: (s: string) => string): string {
	if (width <= 0) return bgFn ? bgFn(text) : text;
	const paddingNeeded = Math.max(0, width - visibleWidth(text));
	const padded = paddingNeeded > 0 ? text + padding(paddingNeeded) : text;
	return bgFn ? bgFn(padded) : padded;
}

export function getStateBgColor(state: State): ThemeBg {
	if (state === "success") return "toolSuccessBg";
	if (state === "error") return "toolErrorBg";
	return "toolPendingBg";
}
