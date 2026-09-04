/**
 * Tokenizer.tokenize / isOp: op recognition is the gate for containsRecognizableHashlineOperations
 * and header vs payload classification.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../src/format";
import { Tokenizer } from "../src/tokenizer";

const tok = new Tokenizer();

describe("Tokenizer.isOp", () => {
	const ops = [
		"SWAP 1.=1:",
		"SWAP 2.=9:",
		"DEL 3",
		"DEL 1.=4",
		"INS.POST 5:",
		"INS.PRE 1:",
		"INS.HEAD:",
		"INS.TAIL:",
		"SWAP.BLK 2:",
		"DEL.BLK 3",
		"INS.BLK.POST 4:",
		"REM",
		"MV dest/path.ts",
	];
	for (const line of ops) {
		it(`isOp true for ${JSON.stringify(line)}`, () => {
			expect(tok.isOp(line)).toBe(true);
		});
	}

	const nonOps = [
		"",
		"plain text",
		"+body row",
		"// comment",
		"function foo() {}",
		"[not a complete header",
		"*** Begin Patch",
	];
	for (const line of nonOps) {
		it(`isOp false for ${JSON.stringify(line)}`, () => {
			expect(tok.isOp(line)).toBe(false);
		});
	}
});

describe("Tokenizer.tokenize headers and envelopes", () => {
	it("tokenizes valid file header with hash", () => {
		const line = formatHashlineHeader("src/a.ts", "ABCD");
		const t = tok.tokenize(line);
		expect(t.kind).toBe("header");
		if (t.kind === "header") {
			expect(t.path).toBe("src/a.ts");
			expect(t.fileHash).toBe("ABCD");
		}
	});

	it("tokenizes header without hash", () => {
		const line = `${HL_FILE_PREFIX}bare.ts${HL_FILE_SUFFIX}`;
		const t = tok.tokenize(line);
		expect(t.kind).toBe("header");
		if (t.kind === "header") {
			expect(t.path).toBe("bare.ts");
			expect(t.fileHash).toBeUndefined();
		}
	});

	it("envelope begin/end/abort", () => {
		expect(tok.tokenize("*** Begin Patch").kind).toBe("envelope-begin");
		expect(tok.tokenize("*** End Patch").kind).toBe("envelope-end");
		expect(tok.tokenize("*** Abort").kind).toBe("abort");
	});

	it("payload + row", () => {
		const t = tok.tokenize("+hello");
		// payload kinds vary; ensure not classified as header/op wrongly
		expect(t.kind).not.toBe("header");
		expect(tok.isOp("+hello")).toBe(false);
	});

	it("malformed hash length is not a clean header token", () => {
		const short = `${HL_FILE_PREFIX}a.ts${HL_FILE_HASH_SEP}AB${HL_FILE_SUFFIX}`;
		const t = tok.tokenize(short);
		// either not header, or recovery path elsewhere — must not silently accept short tags
		if (t.kind === "header") {
			// if classified, hash must still be 4 hex when present
			expect(t.fileHash === undefined || t.fileHash.length === 4).toBe(true);
		}
	});
});

describe("Tokenizer.feed streaming chunks", () => {
	it("feed+end produces same ops as one-shot for complete patch body", () => {
		const body = "SWAP 1.=1:\n+X\nDEL 2\n";
		const oneShot = [...new Tokenizer().feed(body), ...new Tokenizer().end()];
		const stream = new Tokenizer();
		const parts: ReturnType<Tokenizer["tokenize"]>[] = [];
		for (const chunk of ["SWAP 1.=1:\n", "+X\n", "DEL 2\n"]) {
			parts.push(...stream.feed(chunk));
		}
		parts.push(...stream.end());
		// Compare kinds sequence for op/payload tokens (ignore pure whitespace noise)
		const kinds = (ts: typeof oneShot) => ts.map(t => t.kind);
		expect(kinds(parts)).toEqual(kinds(oneShot));
	});
});
