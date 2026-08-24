import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { recordFileSnapshot } from "@veyyon/coding-agent/edit/file-snapshot-store";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/read";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "./helpers/tool-session";

// WHY THIS SUITE EXISTS (BACKLOG PERF-READ-RANGE-ONEPASS)
// ------------------------------------------------------
// A bounded range read used to touch the same file three times: the line
// streamer scanned it for the window, bracket context read and split all of it,
// and the snapshot tag read and normalized all of it again. On a 3.5MiB,
// 100,000-line source, `read big.ts:50000-50019` delivered 3.08x the file's
// bytes. The fix materializes the file once and feeds the window, the bracket
// context and the snapshot from that one materialization.
//
// The class this closes is "the same read reads the file again": a later change
// that re-reads for a tag, for context, or for a total line count fails the
// counting cases below. The parity cases pin what the single materialization is
// NOT allowed to change -- a CRLF file and a BOM file are different files once
// decoded, so they keep the streaming window and share only the text.
//
// What it does not catch: wall-clock time. The remaining cost of a range read on
// a large file is tree-sitter parsing the whole file for bracket context (435ms
// of 466ms measured), which is a separate row and unaffected by anything here.

interface FileReadLedger {
	/** Per absolute path, how many times the file's whole contents were decoded. */
	texts: Map<string, number>;
	/** Per absolute path, how many times it was opened for the chunked line scan. */
	opens: Map<string, number>;
	/** Total whole-file bytes handed to the reader. */
	bytes: number;
}

function bump(counter: Map<string, number>, key: string): void {
	counter.set(key, (counter.get(key) ?? 0) + 1);
}

/**
 * Count every whole-file decode and every line-scan open the tool performs.
 *
 * The two routes to a file's bytes in this path are `Bun.file` (whole contents) and
 * `fs.open` (the chunked line streamer), so wrapping both counts reads without
 * mocking the code under test. The `Bun.file` wrapper is a Proxy rather than a copy
 * because a BunFile carries getters (`size`) the reader uses and cannot be spread.
 */
function ledgerFileReads(): FileReadLedger {
	const ledger: FileReadLedger = { texts: new Map(), opens: new Map(), bytes: 0 };
	const realOpen = fs.open;
	spyOn(fs, "open").mockImplementation(((target: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
		if (typeof target === "string") bump(ledger.opens, target);
		return (realOpen as (...args: unknown[]) => unknown)(target, ...rest);
	}) as typeof fs.open);
	const realFile = Bun.file.bind(Bun);
	spyOn(Bun, "file").mockImplementation(((target: string, options?: BlobPropertyBag) => {
		const file = realFile(target as never, options);
		if (typeof target !== "string") return file;
		return new Proxy(file, {
			get(source, property) {
				if (property === "text" || property === "bytes" || property === "arrayBuffer") {
					return async () => {
						bump(ledger.texts, target);
						const whole = await (source[property] as () => Promise<string | Uint8Array | ArrayBuffer>)();
						ledger.bytes += typeof whole === "string" ? Buffer.byteLength(whole) : whole.byteLength;
						return whole;
					};
				}
				// The real file is the receiver, not the proxy: `size` is a native getter
				// that rejects a foreign `this`, and a throwing read is a read the ledger
				// would never see.
				const value = Reflect.get(source, property, source);
				return typeof value === "function" ? value.bind(source) : value;
			},
		});
	}) as typeof Bun.file);
	return ledger;
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	// Structural summarization would answer a selector read from a different code
	// path; this suite is about the literal-line range read.
	settings.set("read.summarize.enabled", false);
	return makeToolSession({
		cwd,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	});
}

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

/** The 1-based file lines a hashline body actually rendered, from each `N:` prefix. */
function renderedLineNumbers(text: string): number[] {
	const numbers: number[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^(\d+):/);
		if (match) numbers.push(Number(match[1]));
	}
	return numbers;
}

async function withWorkspace<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-onepass-"));
	try {
		return await run(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

/** 400 distinct lines, LF, no CR and no BOM: the materialized-window case. */
function lfSource(): string {
	return `${Array.from({ length: 400 }, (_, i) => `const line_${String(i + 1).padStart(4, "0")} = ${i + 1};`).join("\n")}\n`;
}

afterEach(() => {
	// spyOn installs on the global Bun object and on the fs/promises namespace;
	// every case must hand both back or later files inherit the counters.
	(Bun.file as unknown as { mockRestore?: () => void }).mockRestore?.();
	(fs.open as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("a bounded range read touches the file once", () => {
	it("decodes an LF file exactly once and never streams it", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "big.ts");
			await fs.writeFile(file, lfSource());
			const ledger = ledgerFileReads();
			const tool = new ReadTool(createSession(dir));

			const result = await tool.execute("call-window", { path: "big.ts:200-219" });

			expect(result.isError).toBeFalsy();
			// The header proves the one read also produced the anchor tag: a snapshot
			// that re-reads is either a second read or, when the read fails, no tag.
			expect(textOutput(result)).toMatch(/^\[big\.ts#[0-9A-F]{4}]\n199:/);
			// 1 line of leading context, the 20 requested, 3 trailing: the in-memory
			// collector stops at the same line the streamer would.
			expect(renderedLineNumbers(textOutput(result))).toEqual(Array.from({ length: 24 }, (_, i) => 199 + i));
			expect(ledger.texts.get(file)).toBe(1);
			expect(ledger.opens.get(file)).toBeUndefined();
		});
	});

	it("delivers no more than 1.2x the file's bytes for a 20-line window", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "big.ts");
			const source = lfSource();
			await fs.writeFile(file, source);
			const ledger = ledgerFileReads();
			const tool = new ReadTool(createSession(dir));

			await tool.execute("call-window", { path: "big.ts:200-219" });

			expect(ledger.bytes).toBeLessThanOrEqual(Math.floor(Buffer.byteLength(source) * 1.2));
		});
	});

	it("mints the same tag the file's own bytes hash to", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "big.ts");
			await fs.writeFile(file, lfSource());
			const session = createSession(dir);
			const tool = new ReadTool(session);

			const result = await tool.execute("call-window", { path: "big.ts:200-219" });
			const displayed = textOutput(result).match(/^\[big\.ts#([0-9A-F]{4})\]/)?.[1];
			// A second session re-reads the file itself, so the two tags agree only
			// when the window read fingerprinted the whole normalized file.
			const reread = await recordFileSnapshot(createSession(dir), file);

			expect(displayed).toBeDefined();
			expect(reread).toBe(displayed);
		});
	});

	it("keeps a stale tag rejectable after the file changes", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "big.ts");
			await fs.writeFile(file, lfSource());
			const tool = new ReadTool(createSession(dir));

			const before = textOutput(await tool.execute("call-before", { path: "big.ts:200-219" })).match(
				/^\[big\.ts#([0-9A-F]{4})\]/,
			)?.[1];
			await fs.writeFile(file, `${lfSource()}const appended = 1;\n`);
			const after = textOutput(await tool.execute("call-after", { path: "big.ts:200-219" })).match(
				/^\[big\.ts#([0-9A-F]{4})\]/,
			)?.[1];

			expect(before).toBeDefined();
			expect(after).not.toBe(before);
		});
	});

	it("streams the window of a CRLF file and displays its CR bytes", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "crlf.txt");
			await fs.writeFile(file, "alpha\r\nbeta\r\ngamma\r\n");
			const ledger = ledgerFileReads();
			const tool = new ReadTool(createSession(dir));

			const output = textOutput(await tool.execute("call-crlf", { path: "crlf.txt:2-4" }));

			// The raw split carries a byte the normalized one does not, so the
			// window comes from the streamer even though the text is materialized.
			expect(ledger.opens.get(file)).toBe(1);
			expect(ledger.texts.get(file)).toBe(1);
			expect(output).toContain("1:alpha\r\n2:beta\r\n3:gamma\r");
		});
	});

	it("streams the window of a BOM file and shows the BOM on line 1", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "bom.txt");
			await fs.writeFile(file, "\uFEFFalpha\nbeta\ngamma\n");
			const ledger = ledgerFileReads();
			const tool = new ReadTool(createSession(dir));

			const output = textOutput(await tool.execute("call-bom", { path: "bom.txt:2-4" }));

			// `Bun.file().text()` drops a BOM and the streamer keeps it, so a
			// materialization that decodes the ordinary way would show a first line
			// the reader's file does not have. The BOM file keeps the streamed window.
			expect(ledger.opens.get(file)).toBe(1);
			expect(output).toContain("1:\uFEFFalpha");
		});
	});

	it("refuses an over-long first line with the streamer's own accounting", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "wide.txt");
			// A first line past the display byte budget has no editable numbered form,
			// and the in-memory collector has to reach the same refusal with the same
			// counters as the streamer: nothing emitted, the line total still known.
			await fs.writeFile(file, `${"x".repeat(200_000)}\nsecond\nthird\n`);
			const tool = new ReadTool(createSession(dir));

			const result = await tool.execute("call-wide", { path: "wide.txt:1-3" });
			const truncation = result.details?.truncation;

			expect(textOutput(result)).toContain("Line 1 is 195.3KB, exceeds 50.0KB limit");
			expect(truncation?.truncatedBy).toBe("bytes");
			expect(truncation?.firstLineExceedsLimit).toBe(true);
			expect(truncation?.totalLines).toBe(4);
			expect(truncation?.outputLines).toBe(0);
			expect(truncation?.totalBytes).toBe(0);
		});
	});

	it("stops a window at the byte budget with the streamer's counters", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "wide-mid.txt");
			// Two of these three lines fit the display byte budget and the third does
			// not, so the counters can only come out right if the in-memory collector
			// charges the newline between lines exactly as the streamer does.
			await fs.writeFile(file, `${"a".repeat(20_000)}\n${"b".repeat(20_000)}\n${"c".repeat(20_000)}\nfourth\n`);
			const tool = new ReadTool(createSession(dir));

			const result = await tool.execute("call-wide-mid", { path: "wide-mid.txt:1-3" });
			const truncation = result.details?.truncation;

			expect(truncation?.truncatedBy).toBe("bytes");
			expect(truncation?.outputLines).toBe(2);
			// 20000 + separator + 20000: one byte more than the two lines alone.
			expect(truncation?.outputBytes).toBe(40_001);
			expect(truncation?.totalBytes).toBe(40_001);
			expect(truncation?.totalLines).toBe(5);
			expect(truncation?.lastLinePartial).toBe(false);
		});
	});

	it("keeps the over-long-line refusal for a line past the first", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "one-wide.txt");
			await fs.writeFile(file, `first\n${"y".repeat(200_000)}\nthird\n`);
			const tool = new ReadTool(createSession(dir));

			const result = await tool.execute("call-one-wide", { path: "one-wide.txt:1-3" });
			const truncation = result.details?.truncation;

			// The line that does not fit is dropped whole -- a window never shows a
			// partial line, because a partial line has no editable numbered form.
			expect(truncation?.outputLines).toBe(1);
			expect(truncation?.outputBytes).toBe(5);
			expect(truncation?.lastLinePartial).toBe(false);
		});
	});

	it("refuses a tag for text past the snapshot cap", async () => {
		await withWorkspace(async dir => {
			const file = path.join(dir, "huge.txt");
			const session = createSession(dir);

			const tag = await recordFileSnapshot(session, file, undefined, "y".repeat(5 * 1024 * 1024));

			expect(tag).toBeUndefined();
		});
	});
});
