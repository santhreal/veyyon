/**
 * Expand deferred block edits (`replace_block N:` / `delete_block N` /
 * `insert_after_block N:`) into concrete inserts + deletes.
 *
 * The hashline parser cannot expand a block edit on its own — the line span is
 * unknown until file text + path (→ language) are available. This transform
 * runs at every apply/preview boundary that has text: it calls the injected
 * {@link BlockResolver} to resolve each block's `[start, end]` span, then emits
 * the exact same edits the concrete form produces in the parser: `replace
 * start.=end:` inserts + deletes for a replace, a pure range delete for a
 * delete, and plain `after_anchor` inserts at `end` for an insert-after. After
 * it runs, no `block` edits remain, so {@link applyEdits} (and recovery) only
 * ever see resolved edits.
 */
import { STRUCTURAL_CLOSER_RE } from "./apply";
import {
	BLOCK_RESOLVER_UNAVAILABLE,
	blockSingleLineMessage,
	blockUnresolvedMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
} from "./messages";
import type { BlockResolution, BlockResolver, BlockSpan, Cursor, Edit } from "./types";

type BlockEdit = Extract<Edit, { kind: "block" }>;

export interface ResolveBlockEditsOptions {
	/**
	 * How to handle a replace/delete block edit that cannot be resolved
	 * (missing resolver or a `null` span). `"throw"` (default) raises a
	 * `blockUnresolvedMessage` error — used by the authoritative apply + final
	 * preview paths. `"drop"` silently skips the edit — used by the streaming
	 * preview, where a half-written file or transient parse error must not
	 * throw. Unresolvable `insert_after_block N:` edits never reach this: they
	 * are lowered to plain `insert after N:` with a warning.
	 */
	onUnresolved?: "throw" | "drop";
	/**
	 * Invoked once per successfully resolved block edit, in patch order, with
	 * the anchor line and the concrete span it resolved to. Lets the host echo
	 * the resolution back to the caller. Never fired for dropped/unresolvable
	 * edits.
	 */
	onResolved?: (resolution: BlockResolution) => void;
	/**
	 * Invoked once per diagnostic produced while resolving — currently the
	 * `insert_after_block N:` lowerings (closer anchor or unresolvable block).
	 * Hosts should surface these on the apply result's `warnings`.
	 */
	onWarning?: (message: string) => void;
}

/** True when at least one edit is an unresolved deferred block edit. */
export function hasBlockEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => edit.kind === "block");
}

/**
 * True when at least one edit anchors to concrete file content. A delete, a
 * `replace_block N:` (anchored to line N), and any `before_anchor` /
 * `after_anchor` insert all bind to existing text; pure `insert head:` /
 * `insert tail:` literal inserts do not, so a section built only from those is
 * safe to apply to a file that does not yet exist. Callers use this to decide
 * whether a stale-hash section must go through snapshot recovery before apply.
 */
export function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		if (edit.kind === "block") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

/**
 * Resolve every deferred block edit in `edits` against `text` (parsed as the
 * language inferred from `path`). Non-block edits pass through untouched.
 * Returns a fresh edit list with no `block` variants. The fast path returns the
 * input unchanged when there is nothing to resolve.
 *
 * Synthesized inserts/deletes carry sequential `index` values for readability
 * only — {@link applyEdits} re-derives every edit's index from array order, so
 * the passthrough edits keeping their original indices is harmless.
 */
export function resolveBlockEdits(
	edits: readonly Edit[],
	text: string,
	path: string,
	resolver: BlockResolver | undefined,
	options: ResolveBlockEditsOptions = {},
): readonly Edit[] {
	if (!hasBlockEdit(edits)) return edits;
	const lowering = new BlockLowering(text, path, resolver, options);
	for (const edit of edits) {
		if (edit.kind === "block") lowering.lower(edit);
		else lowering.edits.push(edit);
	}
	return lowering.edits;
}

/**
 * Lowers block edits against one text into the concrete edits they expand to,
 * numbering each synthesized edit in emit order.
 */
class BlockLowering {
	readonly edits: Edit[] = [];
	#synthIndex = 0;
	readonly #text: string;
	readonly #path: string;
	readonly #resolver: BlockResolver | undefined;
	readonly #options: ResolveBlockEditsOptions;

	constructor(text: string, path: string, resolver: BlockResolver | undefined, options: ResolveBlockEditsOptions) {
		this.#text = text;
		this.#path = path;
		this.#resolver = resolver;
		this.#options = options;
	}

	lower(edit: BlockEdit): void {
		const op: BlockResolution["op"] =
			edit.mode === "insert_after" ? "insert_after" : edit.payloads.length === 0 ? "delete" : "replace";
		const span = this.#resolver
			? this.#resolver({ path: this.#path, text: this.#text, line: edit.anchor.line })
			: null;
		if (span === null) {
			this.#lowerUnresolved(edit, op);
			return;
		}
		if (span.start === span.end) {
			// A single-line block resolution means line N is a bare statement, not
			// the opening line of a multi-line construct — the common mis-anchor
			// that lands a body in the wrong scope (e.g. between a `case` body line
			// and its `break;`). The plain op is exact for one line, so reject and
			// point at it; drop instead on the lenient preview path.
			if (this.#options.onUnresolved === "drop") return;
			throw new Error(`line ${edit.lineNum}: ${blockSingleLineMessage(edit.anchor.line, op)}`);
		}
		this.#options.onResolved?.({ anchorLine: edit.anchor.line, start: span.start, end: span.end, op });
		// Mirror the parser's `insert after N:` lowering, anchored on the block's
		// last line. The `blockStart` tag lets the applier's landing correction
		// slide a body that claims a depth inside the block back across the
		// block's trailing closer lines.
		if (op === "insert_after") this.#insertAfter(edit, span.end, span.start);
		else this.#replaceSpan(edit, span);
	}

	#lowerUnresolved(edit: BlockEdit, op: BlockResolution["op"]): void {
		if (op === "insert_after") {
			// `insert_after_block N:` never fails the patch — lower it to plain
			// `insert after N:` with a warning instead. Two flavors:
			// - anchored on a pure closing-delimiter line: no block begins
			//   there, but line N IS the end of one, and "after the end of the
			//   block" is exactly the plain form — warn with the opener rule.
			// - otherwise (unsupported language, blank line, unparsable block,
			//   or no resolver wired): "after the block at N" degrades to
			//   "after line N" — warn to verify the landing line.
			const anchorText = this.#text.split("\n")[edit.anchor.line - 1];
			const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
			this.#options.onWarning?.(
				isCloser
					? insertAfterBlockCloserLoweredWarning(edit.anchor.line)
					: insertAfterBlockUnresolvedLoweredWarning(edit.anchor.line),
			);
			this.#insertAfter(edit, edit.anchor.line);
			return;
		}
		if (this.#options.onUnresolved === "drop") return;
		const reason = this.#resolver
			? blockUnresolvedMessage(edit.anchor.line, op, this.#text.split("\n"))
			: BLOCK_RESOLVER_UNAVAILABLE;
		throw new Error(`line ${edit.lineNum}: ${reason}`);
	}

	/** One `after_anchor` insert per payload row at `line`, tagged with `blockStart` when the block resolved. */
	#insertAfter(edit: BlockEdit, line: number, blockStart?: number): void {
		for (const payload of edit.payloads) {
			const cursor: Cursor = { kind: "after_anchor", anchor: { line } };
			const insert: Edit = {
				kind: "insert",
				cursor,
				text: payload,
				lineNum: edit.lineNum,
				index: this.#synthIndex++,
			};
			if (blockStart !== undefined) insert.blockStart = blockStart;
			this.edits.push(insert);
		}
	}

	/**
	 * Mirror the parser's `replace start.=end:` expansion exactly: one
	 * `before_anchor` replacement insert per payload row at `span.start`, then
	 * one delete per line across `[span.start, span.end]`. An empty `payloads`
	 * (from `delete_block N`) emits no inserts — a pure deletion.
	 */
	#replaceSpan(edit: BlockEdit, span: BlockSpan): void {
		for (const payload of edit.payloads) {
			const cursor: Cursor = { kind: "before_anchor", anchor: { line: span.start } };
			this.edits.push({
				kind: "insert",
				cursor,
				text: payload,
				lineNum: edit.lineNum,
				index: this.#synthIndex++,
				mode: "replacement",
			});
		}
		for (let line = span.start; line <= span.end; line++) {
			this.edits.push({ kind: "delete", anchor: { line }, lineNum: edit.lineNum, index: this.#synthIndex++ });
		}
	}
}
