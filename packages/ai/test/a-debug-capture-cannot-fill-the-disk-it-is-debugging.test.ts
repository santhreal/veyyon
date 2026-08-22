/**
 * A debug capture cannot end the session it was switched on to diagnose.
 *
 * WHY THIS SUITE EXISTS. `VEYYON_REQ_DEBUG=1` wrote every byte a provider sent to
 * `rr-session-N.res.log` with no ceiling, so a provider or proxy that keeps a response
 * flowing filled the filesystem, and the outage landed on the whole machine rather than
 * on the request being recorded. The request side had the same shape from the other
 * direction: `input.clone().arrayBuffer()` and `blob.arrayBuffer()` read the whole body
 * into memory next to the copy the real request was already carrying, so recording an
 * attachment doubled its cost.
 *
 * THE CLASS, not the incident. Every route into a capture is bounded by one ceiling:
 * the response log, and each kind of request body (string, search params, bytes, a
 * view, a blob, a `Request` whose body is a stream). The kinds are swept, and the two
 * that are deliberately not captured are pinned by exact equality, so adding a body
 * kind that reads without a bound turns this red rather than shipping.
 *
 * WHAT IS ASSERTED, and why it is shaped this way. The bound is proved against a
 * CONTROL recorded with a ceiling nothing can reach: the bounded capture must omit
 * exactly what the unbounded one wrote, which is stronger than "the file got smaller"
 * and does not depend on this suite knowing the header block's format. The response
 * the caller receives is compared byte for byte in the same tests, because a bound that
 * costs the caller a byte of their answer is not a bound, it is a bug.
 *
 * WHAT THIS DOES NOT CATCH. It does not prove the default ceiling is the right size,
 * only that it is in force and that the knob moves it; and it says nothing about the
 * dump's redaction, which `request-debug-keeps-credentials-out-of-the-dump.test.ts`
 * owns. It also cannot separate the two bounds on an in-memory byte body: the prefix
 * slice and the character ceiling produce identical output, so removing one is invisible
 * here and only removing both is a defect the mutation gate can see.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// The `Blob` in scope is node's, and its `stream()` is node's web stream: the counting
// override below has to return that flavour, not the global one.
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FetchImpl } from "@veyyon/ai/types";
import {
	DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES,
	requestDebugCaptureCeiling,
	wrapFetchForRequestDebug,
} from "@veyyon/ai/utils/request-debug";
import * as logger from "@veyyon/utils/logger";
import { removeWithRetries } from "../../utils/src/temp";

/** Small enough to cross in a test, large enough to hold the header block. */
const CEILING = 512;
/** A ceiling nothing in this suite can reach, for the control recordings. */
const UNBOUNDED = 64 * 1024 * 1024;
const ENDPOINT = "https://provider.test/v1/messages";

let previousDebugFlag: string | undefined;
let previousCeiling: string | undefined;
let previousCwd: string;
let tempDir: string;

beforeEach(async () => {
	previousDebugFlag = Bun.env.VEYYON_REQ_DEBUG;
	previousCeiling = Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES;
	previousCwd = process.cwd();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-req-debug-bounds-"));
	process.chdir(tempDir);
	Bun.env.VEYYON_REQ_DEBUG = "1";
});

afterEach(async () => {
	process.chdir(previousCwd);
	if (previousDebugFlag === undefined) delete Bun.env.VEYYON_REQ_DEBUG;
	else Bun.env.VEYYON_REQ_DEBUG = previousDebugFlag;
	if (previousCeiling === undefined) delete Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES;
	else Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES = previousCeiling;
	await removeWithRetries(tempDir);
});

interface Dump {
	readonly requestPath: string;
	readonly responsePath: string;
}

async function latestDump(): Promise<Dump> {
	const entries = await fs.readdir(tempDir);
	const ids = entries
		.filter(name => /^rr-session-\d+\.json$/.test(name))
		.map(name => Number(/\d+/.exec(name)?.[0] ?? "0"))
		.sort((a, b) => a - b);
	const id = ids[ids.length - 1];
	if (id === undefined) throw new Error(`no rr-session dump in ${tempDir}: ${entries.join(", ")}`);
	return {
		requestPath: path.join(tempDir, `rr-session-${id}.json`),
		responsePath: path.join(tempDir, `rr-session-${id}.res.log`),
	};
}

function chunkedBody(chunk: Uint8Array, count: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= count) {
				controller.close();
				return;
			}
			sent += 1;
			controller.enqueue(chunk);
		},
	});
}

interface Recorded {
	readonly bodyReceivedByCaller: Uint8Array;
	readonly log: string;
	readonly logBytes: number;
}

/** Drive the real wrapped fetch against a response and read back both sides. */
async function recordResponse(
	ceiling: number,
	body: string | ReadableStream<Uint8Array>,
	contentType = "text/plain",
): Promise<Recorded> {
	Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES = String(ceiling);
	const fetchImpl: FetchImpl = async () => new Response(body, { headers: { "content-type": contentType } });
	const response = await wrapFetchForRequestDebug(fetchImpl)(ENDPOINT, { method: "POST", body: "{}" });
	const received = new Uint8Array(await response.arrayBuffer());
	const { responsePath } = await latestDump();
	const raw = await fs.readFile(responsePath);
	return { bodyReceivedByCaller: received, log: raw.toString("utf8"), logBytes: raw.byteLength };
}

const CEILING_MARKER = "\n[veyyon request debug] capture ceiling reached";

function tally(log: string): { captured: number; omitted: number } {
	const match = /\[veyyon request debug\] captured (\d+) bytes, omitted (\d+) bytes/.exec(log);
	if (!match) throw new Error(`no tally marker in log: ${log.slice(-200)}`);
	return { captured: Number(match[1]), omitted: Number(match[2]) };
}

describe("a response capture stops at the ceiling", () => {
	it("records the ceiling, marks the cut, and still hands the caller every byte", async () => {
		const body = "R".repeat(4096);
		const control = await recordResponse(UNBOUNDED, body);
		const bounded = await recordResponse(CEILING, body);

		// The caller's answer is untouched by the bound, in both recordings.
		expect(new TextDecoder().decode(control.bodyReceivedByCaller)).toBe(body);
		expect(new TextDecoder().decode(bounded.bodyReceivedByCaller)).toBe(body);

		// Exactly the ceiling was written before the marker: the marker's own offset is
		// the count, so this does not depend on the header block's format.
		expect(bounded.log.indexOf(CEILING_MARKER)).toBe(CEILING);
		expect(bounded.log).not.toContain(body.slice(CEILING));

		// The bounded capture omitted exactly what the unbounded one wrote.
		const counts = tally(bounded.log);
		expect(counts.captured).toBe(CEILING);
		expect(counts.captured + counts.omitted).toBe(control.logBytes);
	});

	it("bounds a response that arrives in many small chunks", async () => {
		const chunk = new Uint8Array(64).fill(0x41);
		const total = 64 * 64;
		const control = await recordResponse(UNBOUNDED, chunkedBody(chunk, 64));
		const bounded = await recordResponse(CEILING, chunkedBody(chunk, 64));

		expect(control.bodyReceivedByCaller.byteLength).toBe(total);
		expect(bounded.bodyReceivedByCaller.byteLength).toBe(total);
		expect(bounded.log.indexOf(CEILING_MARKER)).toBe(CEILING);

		const counts = tally(bounded.log);
		expect(counts.captured).toBe(CEILING);
		expect(counts.captured + counts.omitted).toBe(control.logBytes);
		// One cut, not one per chunk after it.
		expect(bounded.log.split("capture ceiling reached").length - 1).toBe(1);
	});

	it("leaves a response under the ceiling byte-identical to an unbounded capture", async () => {
		const body = "small enough";
		const control = await recordResponse(UNBOUNDED, body);
		const bounded = await recordResponse(CEILING, body);

		expect(bounded.log).toBe(control.log);
		expect(bounded.log).not.toContain("[veyyon request debug]");
		expect(bounded.log).toContain(body);
	});

	it("names the file that stopped recording", async () => {
		const warn = spyOn(logger, "warn");
		try {
			await recordResponse(CEILING, "W".repeat(4096));
			const { responsePath } = await latestDump();
			const paths = warn.mock.calls
				.map(call => call[1])
				.filter((fields): fields is { path: string } => typeof (fields as { path?: unknown })?.path === "string")
				.map(fields => fields.path);
			// The module names its files relative to the working directory it wrote them in,
			// which is how every other diagnostic on this path spells them.
			expect(paths).toContain(path.basename(responsePath));
		} finally {
			warn.mockRestore();
		}
	});
});

/** Every body kind a caller can hand `fetch`, minus the two recorded as unavailable. */
type CaseBody = string | URLSearchParams | ArrayBuffer | Uint8Array | Blob;

interface RequestCase {
	readonly kind: string;
	readonly body: () => CaseBody;
	/** Bytes the body really carries, or `null` when the sender never declares it. */
	readonly totalBytes: number | null;
}

const OVER_CEILING = 4096;

const REQUEST_CASES: readonly RequestCase[] = [
	{ kind: "string", body: () => "S".repeat(OVER_CEILING), totalBytes: OVER_CEILING },
	{
		kind: "URLSearchParams",
		body: () => new URLSearchParams({ prompt: "P".repeat(OVER_CEILING) }),
		totalBytes: OVER_CEILING + "prompt=".length,
	},
	{ kind: "ArrayBuffer", body: () => new Uint8Array(OVER_CEILING).fill(0x42).buffer, totalBytes: OVER_CEILING },
	{ kind: "Uint8Array", body: () => new Uint8Array(OVER_CEILING).fill(0x43), totalBytes: OVER_CEILING },
	{ kind: "Blob", body: () => new Blob(["B".repeat(OVER_CEILING)]), totalBytes: OVER_CEILING },
];

/** The two kinds that are recorded as unavailable rather than read. */
const NOT_CAPTURED = ["FormData", "ReadableStream"] as const;

interface RequestDump {
	readonly bodyText?: string;
	readonly bodyBase64?: string;
	readonly bodyUnavailable?: string;
	readonly body?: unknown;
	readonly bodyCapture?: { capturedBytes: number; omittedBytes: number | null };
}

async function recordRequest(ceiling: number, init: RequestInit): Promise<RequestDump> {
	Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES = String(ceiling);
	const fetchImpl: FetchImpl = async () => new Response("ok");
	const response = await wrapFetchForRequestDebug(fetchImpl)(ENDPOINT, init);
	await response.text();
	const { requestPath } = await latestDump();
	return JSON.parse(await fs.readFile(requestPath, "utf8")) as RequestDump;
}

describe("a request-body capture stops at the ceiling", () => {
	it.each(REQUEST_CASES.map(entry => [entry.kind, entry] as const))(
		"bounds a %s body and states what it omitted",
		async (_kind, entry) => {
			const dump = await recordRequest(CEILING, { method: "POST", body: entry.body() });

			expect(dump.bodyCapture).toBeDefined();
			expect(dump.bodyCapture?.capturedBytes).toBe(CEILING);
			expect(dump.bodyCapture?.omittedBytes).toBe((entry.totalBytes ?? 0) - CEILING);
			const recorded = dump.bodyText ?? dump.bodyBase64 ?? "";
			expect(recorded.length).toBeGreaterThan(0);
			expect(Buffer.byteLength(dump.bodyText ?? "", "utf8")).toBeLessThanOrEqual(CEILING);
		},
	);

	/**
	 * The bound has to be on the READ, not on what is written afterwards. A blob knows
	 * its own size, so a capture that read the whole attachment and then trimmed the
	 * dump would report exactly the same numbers as one that read a prefix — which is
	 * the defect this row is about. Counting the bytes the capture actually pulled is
	 * the only way to tell those two apart, so the blob hands out a stream that counts.
	 */
	it("pulls only the prefix out of an oversized attachment", async () => {
		let pulled = 0;
		class CountingBlob extends Blob {
			override stream(): NodeReadableStream<NodeJS.NonSharedUint8Array> {
				const chunk = new Uint8Array(64).fill(0x44);
				let sent = 0;
				return new NodeReadableStream<NodeJS.NonSharedUint8Array>({
					pull(controller) {
						if (sent >= OVER_CEILING / 64) {
							controller.close();
							return;
						}
						sent += 1;
						pulled += chunk.byteLength;
						controller.enqueue(chunk);
					},
				});
			}
		}
		const blob = new CountingBlob([new Uint8Array(OVER_CEILING).fill(0x44)]);

		const dump = await recordRequest(CEILING, { method: "POST", body: blob });

		expect(dump.bodyCapture).toEqual({ capturedBytes: CEILING, omittedBytes: OVER_CEILING - CEILING });
		// Enough to fill the ceiling, and not one chunk more.
		expect(pulled).toBe(CEILING);
	});

	it("sweeps every body kind, and only the two opted out go uncaptured", async () => {
		const uncaptured: string[] = [];
		for (const entry of REQUEST_CASES) {
			const dump = await recordRequest(CEILING, { method: "POST", body: entry.body() });
			if (dump.bodyUnavailable !== undefined) uncaptured.push(entry.kind);
		}
		const form = new FormData();
		form.append("prompt", "F".repeat(OVER_CEILING));
		const formDump = await recordRequest(CEILING, { method: "POST", body: form });
		if (formDump.bodyUnavailable !== undefined) uncaptured.push(formDump.bodyUnavailable);
		const streamDump = await recordRequest(CEILING, {
			method: "POST",
			body: chunkedBody(new Uint8Array(64).fill(0x53), 64),
		});
		if (streamDump.bodyUnavailable !== undefined) uncaptured.push(streamDump.bodyUnavailable);

		expect(uncaptured).toEqual([...NOT_CAPTURED]);
	});

	it("bounds a Request whose length the sender declared, and still sends it whole", async () => {
		const body = "Q".repeat(OVER_CEILING);
		const sent: string[] = [];
		Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES = String(CEILING);
		const fetchImpl: FetchImpl = async input => {
			if (input instanceof Request) sent.push(await input.text());
			return new Response("ok");
		};
		const request = new Request(ENDPOINT, {
			method: "POST",
			body,
			// Bun does not put a length on a `Request` the caller built, so the declared
			// case is the one where the caller said how long the body is.
			headers: { "content-length": String(OVER_CEILING) },
		});
		const response = await wrapFetchForRequestDebug(fetchImpl)(request);
		await response.text();

		const { requestPath } = await latestDump();
		const dump = JSON.parse(await fs.readFile(requestPath, "utf8")) as RequestDump;

		expect(dump.bodyCapture).toEqual({ capturedBytes: CEILING, omittedBytes: OVER_CEILING - CEILING });
		expect(dump.bodyText).toBe(body.slice(0, CEILING));
		// The capture read a clone; the provider still got the whole body.
		expect(sent).toEqual([body]);
	});

	it("says the omitted count is unknown when the sender declared no length", async () => {
		Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES = String(CEILING);
		const fetchImpl: FetchImpl = async () => new Response("ok");
		const request = new Request(ENDPOINT, {
			method: "POST",
			body: chunkedBody(new Uint8Array(64).fill(0x5a), 64),
			headers: { "content-type": "application/octet-stream" },
		});
		const response = await wrapFetchForRequestDebug(fetchImpl)(request);
		await response.text();

		const { requestPath } = await latestDump();
		const dump = JSON.parse(await fs.readFile(requestPath, "utf8")) as RequestDump;

		expect(dump.bodyCapture).toEqual({ capturedBytes: CEILING, omittedBytes: null });
	});

	it("leaves a body under the ceiling parsed as the JSON it is", async () => {
		const dump = await recordRequest(CEILING, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "debug-model" }),
		});

		expect(dump.bodyCapture).toBeUndefined();
		expect(dump.body).toEqual({ model: "debug-model" });
	});

	it("cuts a multibyte body between characters, not through one", async () => {
		// Every character is two bytes and the ceiling is odd, so a naive byte slice
		// would end mid-character and the dump would carry a replacement character.
		const dump = await recordRequest(511, { method: "POST", body: "é".repeat(OVER_CEILING) });

		expect(dump.bodyText).not.toContain("\ufffd");
		expect(dump.bodyCapture?.capturedBytes).toBe(510);
		expect(dump.bodyCapture?.omittedBytes).toBe(OVER_CEILING * 2 - 510);
		expect(dump.bodyText).toBe("é".repeat(255));
	});
});

describe("the ceiling itself", () => {
	it("defaults to 32 MiB when the knob is unset", () => {
		delete Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES;

		expect(DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES).toBe(32 * 1024 * 1024);
		expect(requestDebugCaptureCeiling()).toBe(DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES);
	});

	it("honours a value the operator set", () => {
		Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES = "4096";

		expect(requestDebugCaptureCeiling()).toBe(4096);
	});

	it.each(["0", "-1", "abc", "1.5", "  ", "1e400"])("falls back to the default for %p", raw => {
		Bun.env.VEYYON_REQ_DEBUG_MAX_BYTES = raw;

		// A typo is not a request for no ceiling: treating `0` as unlimited would turn a
		// mistake into the outage the ceiling exists to prevent.
		expect(requestDebugCaptureCeiling()).toBe(DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES);
	});
});
