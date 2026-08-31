/**
 * Patcher write-back preserves CRLF and BOM across SWAP/DEL/INS on real NodeFilesystem when needed;
 * InMemory path still applies LF content. Focus: InMemory + explicit ending via normalize helpers used by patcher.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	detectLineEnding,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	normalizeToLF,
	Patch,
	Patcher,
	restoreLineEndings,
	stripBom,
} from "@veyyon/hashline";

describe("Patcher CRLF file through apply (in-memory stores LF)", () => {
	it("CRLF content is stored and returned with CR preserved after SWAP", async () => {
		const content = "a\r\nb\r\nc\r\n";
		const fs = new InMemoryFilesystem([["w.txt", content]]);
		const snapshots = new InMemorySnapshotStore();
		// Hash is computed on LF-normalized text inside patcher; record normalized for tag match
		const lf = normalizeToLF(stripBom(content).text);
		const tag = snapshots.record("w.txt", lf);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("w.txt", tag)}\nSWAP 2.=2:\n+B`));
		const out = fs.get("w.txt")!;
		expect(detectLineEnding(out)).toBe("\r\n");
		expect(normalizeToLF(out)).toBe("a\nB\nc\n");
	});

	it("BOM is re-applied after edit when original had BOM", async () => {
		const body = "line\n";
		const withBom = `\uFEFF${body}`;
		const fs = new InMemoryFilesystem([["b.ts", withBom]]);
		const snapshots = new InMemorySnapshotStore();
		const { text: stripped } = stripBom(withBom);
		const tag = snapshots.record("b.ts", stripped);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("b.ts", tag)}\nSWAP 1.=1:\n+LINE`));
		const out = fs.get("b.ts")!;
		expect(out.startsWith("\uFEFF")).toBe(true);
		expect(stripBom(out).text).toBe("LINE\n");
	});
});

describe("restoreLineEndings matrix used by write-back", () => {
	it("CRLF restore of multi-line LF text", () => {
		const lf = "a\nb\nc";
		expect(restoreLineEndings(lf, "\r\n")).toBe("a\r\nb\r\nc");
		expect(restoreLineEndings(lf, "\n")).toBe(lf);
	});

	it("empty and single-line", () => {
		expect(restoreLineEndings("", "\r\n")).toBe("");
		expect(restoreLineEndings("only", "\r\n")).toBe("only");
	});

	it("hash of LF-normalized equals hash used for tags", () => {
		const crlf = "x\r\ny\r\n";
		expect(computeFileHash(normalizeToLF(crlf))).toBe(computeFileHash("x\ny\n"));
	});
});
