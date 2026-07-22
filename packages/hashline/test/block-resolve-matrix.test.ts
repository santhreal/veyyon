/**
 * Block resolve/anchor classification matrices beyond the core block.test.ts cases.
 */
import { describe, expect, it } from "bun:test";
import {
	type BlockResolver,
	type BlockSpan,
	type Edit,
	hasAnchorScopedEdit,
	hasBlockEdit,
	parsePatch,
	resolveBlockEdits,
} from "@veyyon/hashline";
import {
	BLOCK_RESOLVER_UNAVAILABLE,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
} from "../src/messages";

const PATH = "mod.ts";
const span =
	(start: number, end: number): BlockResolver =>
	() => ({ start, end });

function norm(edits: readonly Edit[]): unknown[] {
	return edits.map(edit => {
		if (edit.kind === "insert") return { kind: "insert", cursor: edit.cursor, text: edit.text };
		if (edit.kind === "delete") return { kind: "delete", line: edit.anchor.line };
		if (edit.kind === "block")
			return { kind: "block", line: edit.anchor.line, mode: edit.mode, payloads: edit.payloads };
		return edit;
	});
}

describe("hasBlockEdit / hasAnchorScopedEdit", () => {
	it("hasBlockEdit true only for block kind", () => {
		expect(hasBlockEdit(parsePatch("SWAP 1.=1:\n+x").edits)).toBe(false);
		expect(hasBlockEdit(parsePatch("SWAP.BLK 2:\n+x").edits)).toBe(true);
		expect(hasBlockEdit(parsePatch("DEL.BLK 3").edits)).toBe(true);
		expect(hasBlockEdit(parsePatch("INS.BLK.POST 4:\n+x").edits)).toBe(true);
	});

	it("hasAnchorScopedEdit true for delete, block, and anchored inserts", () => {
		expect(hasAnchorScopedEdit(parsePatch("DEL 1").edits)).toBe(true);
		expect(hasAnchorScopedEdit(parsePatch("SWAP.BLK 1:\n+a").edits)).toBe(true);
		expect(hasAnchorScopedEdit(parsePatch("INS.POST 2:\n+a").edits)).toBe(true);
		expect(hasAnchorScopedEdit(parsePatch("INS.PRE 2:\n+a").edits)).toBe(true);
		// head/tail alone do not require existing file content
		expect(hasAnchorScopedEdit(parsePatch("INS.HEAD:\n+a").edits)).toBe(false);
		expect(hasAnchorScopedEdit(parsePatch("INS.TAIL:\n+a").edits)).toBe(false);
	});
});

describe("resolveBlockEdits expansion matrix", () => {
	it("DEL.BLK expands to pure range delete", () => {
		const edits = parsePatch("DEL.BLK 5").edits;
		const resolved = resolveBlockEdits(edits, "text", PATH, span(5, 8));
		expect(resolved.every(e => e.kind === "delete")).toBe(true);
		expect(
			resolved.map(e => (e.kind === "delete" ? e.anchor.line : 0)),
		).toEqual([5, 6, 7, 8]);
	});

	it("SWAP.BLK expands like concrete SWAP start.=end", () => {
		const block = parsePatch("SWAP.BLK 2:\n+A\n+B\n+C").edits;
		const concrete = parsePatch("SWAP 2.=4:\n+A\n+B\n+C").edits;
		const resolved = resolveBlockEdits(block, "t", PATH, span(2, 4));
		expect(norm(resolved)).toEqual(norm(concrete));
	});

	it("INS.BLK.POST resolves to after_anchor inserts at block end", () => {
		const edits = parsePatch("INS.BLK.POST 2:\n+X").edits;
		const resolved = resolveBlockEdits(edits, "t", PATH, span(2, 6));
		expect(resolved).toHaveLength(1);
		const e = resolved[0];
		if (e?.kind !== "insert") throw new Error("expected insert");
		expect(e.cursor).toEqual({ kind: "after_anchor", anchor: { line: 6 } });
		expect(e.text).toBe("X");
	});

	it("onResolved fires once per successful multi-line block in order", () => {
		// Single-line spans (start === end) reject via blockSingleLineMessage and
		// never call onResolved — use multi-line spans only.
		const edits = parsePatch("SWAP.BLK 1:\n+a\nDEL.BLK 10").edits;
		const seen: Array<{ start: number; end: number; anchorLine: number; op: string }> = [];
		const resolver: BlockResolver = ({ line }): BlockSpan =>
			line === 1 ? { start: 1, end: 2 } : { start: 10, end: 11 };
		resolveBlockEdits(edits, "t", PATH, resolver, {
			onResolved: r =>
				seen.push({ start: r.start, end: r.end, anchorLine: r.anchorLine, op: r.op }),
		});
		expect(seen).toEqual([
			{ start: 1, end: 2, anchorLine: 1, op: "replace" },
			{ start: 10, end: 11, anchorLine: 10, op: "delete" },
		]);
	});

	it("passthrough non-block edits keep their relative order around blocks", () => {
		const edits = parsePatch("DEL 1\nSWAP.BLK 3:\n+Z\nINS.TAIL:\n+T").edits;
		const resolved = resolveBlockEdits(edits, "t", PATH, span(3, 4));
		expect(resolved[0]?.kind).toBe("delete");
		if (resolved[0]?.kind === "delete") expect(resolved[0].anchor.line).toBe(1);
		expect(resolved.some(e => e.kind === "insert" && e.text === "Z")).toBe(true);
		const last = resolved[resolved.length - 1];
		expect(last?.kind).toBe("insert");
		if (last?.kind === "insert") {
			expect(last.text).toBe("T");
			expect(last.cursor.kind).toBe("eof");
		}
	});

	it("missing resolver throw uses BLOCK_RESOLVER_UNAVAILABLE", () => {
		const edits = parsePatch("SWAP.BLK 1:\n+x").edits;
		expect(() => resolveBlockEdits(edits, "t", PATH, undefined)).toThrow(BLOCK_RESOLVER_UNAVAILABLE);
	});

	it("INS.BLK.POST unresolvable lowers to plain INS.POST with warning", () => {
		const edits = parsePatch("INS.BLK.POST 2:\n+X").edits;
		const warnings: string[] = [];
		const resolved = resolveBlockEdits(edits, "a\nb\nc", PATH, () => null, {
			onWarning: m => warnings.push(m),
		});
		expect(resolved).toHaveLength(1);
		if (resolved[0]?.kind === "insert") {
			expect(resolved[0].cursor).toEqual({ kind: "after_anchor", anchor: { line: 2 } });
		}
		expect(warnings).toEqual([insertAfterBlockUnresolvedLoweredWarning(2)]);
	});

	it("INS.BLK.POST on closer line uses closer-lowered warning", () => {
		const text = "fn() {\n  body\n}";
		const edits = parsePatch("INS.BLK.POST 3:\n+sib").edits;
		const warnings: string[] = [];
		const resolved = resolveBlockEdits(edits, text, PATH, () => null, {
			onWarning: m => warnings.push(m),
		});
		expect(warnings).toEqual([insertAfterBlockCloserLoweredWarning(3)]);
		if (resolved[0]?.kind === "insert") {
			expect(resolved[0].cursor).toEqual({ kind: "after_anchor", anchor: { line: 3 } });
		}
	});

	it("drop mode skips unresolvable replace/delete but still lowers insert_after", () => {
		const edits = parsePatch("SWAP.BLK 1:\n+x\nINS.BLK.POST 2:\n+y").edits;
		const resolved = resolveBlockEdits(edits, "a\nb", PATH, () => null, {
			onUnresolved: "drop",
		});
		expect(resolved.every(e => e.kind !== "block")).toBe(true);
		expect(resolved.some(e => e.kind === "insert" && e.text === "y")).toBe(true);
		expect(resolved.some(e => e.kind === "insert" && e.text === "x")).toBe(false);
	});
});
