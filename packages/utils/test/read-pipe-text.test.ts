/**
 * `readPipeText`: drain a spawned process's pipe, treating an absent pipe as empty output.
 *
 * WHY THIS SUITE EXISTS. `Bun.spawn` hands back `null` for a stream that was not piped, and both
 * runtime installers that report a failed install read their child's output through this. A
 * missing pipe is not an error there: it means the process was configured not to capture that
 * stream, and the diagnostic being assembled should say "no output" rather than throw while
 * reporting someone else's failure. Both installers had a private copy of exactly that guard,
 * which is a two-line function whose only interesting behaviour is the case a copy would drop.
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "../src/ptree";
import { readPipeText } from "../src/stream";
import { collectPackageSources } from "./support/package-sources";

describe("a pipe that was captured", () => {
	/** The whole stream, decoded as UTF-8, which is what a compiler or installer wrote. */
	it("returns everything the stream carried", async () => {
		const stream = new Response("error: could not resolve dependency\nexit 1\n").body;

		expect(await readPipeText(stream)).toBe("error: could not resolve dependency\nexit 1\n");
	});

	it("returns an empty string for a stream that carried nothing", async () => {
		expect(await readPipeText(new Response("").body)).toBe("");
	});

	/** Output arrives in chunks, and a multi-byte character can straddle two of them. */
	it("joins chunks and decodes a character split across them", async () => {
		const bytes = new TextEncoder().encode("naïve build ✓");
		const split = 4; // inside the two bytes of "ï"
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, split));
				controller.enqueue(bytes.subarray(split));
				controller.close();
			},
		});

		expect(await readPipeText(stream)).toBe("naïve build ✓");
	});

	/** Real installer output is large; nothing here truncates it. */
	it("does not truncate a large stream", async () => {
		const line = "warning: peer dependency not satisfied\n";
		const text = line.repeat(5_000);

		expect(await readPipeText(new Response(text).body)).toHaveLength(text.length);
	});
});

describe("a pipe that was never opened", () => {
	/**
	 * THE case the function exists for. `Bun.spawn` gives null when a stream was not piped, and
	 * the caller is usually mid-way through building an error message about something else.
	 */
	it("reads as empty output rather than throwing", async () => {
		expect(await readPipeText(null)).toBe("");
	});
});

describe("the two runtime installers", () => {
	/**
	 * The lock. Each had its own `readPipe`, and each is the code that explains a failed install
	 * to an operator: if one dropped the null guard, a failed install would be reported as a
	 * TypeError about reading a stream instead of as the install error the operator needs.
	 */
	it("share the owner and define no private reader", async () => {
		const files = [
			new URL("../src/runtime-install.ts", import.meta.url),
			new URL("../../coding-agent/src/subprocess/worker-runtime.ts", import.meta.url),
		];

		for (const file of files) {
			const source = await Bun.file(file).text();

			expect(source).not.toContain("function readPipe(");
			expect(source).toContain("readPipeText(");
		}
	});
});

describe("every process pipe in the repository", () => {
	/**
	 * The sweep, and the lock that keeps it swept.
	 *
	 * Beyond the two installers above, 34 further sites across ai, coding-agent, utils, natives and
	 * the bench harnesses spelled `new Response(proc.stdout).text()` inline, four of them casting the
	 * pipe (`proc.stderr as ReadableStream`) to get past the compiler. None of the 34 was a live bug:
	 * checked one at a time, each either pipes the stream it reads or guards it by hand, and `ptree`
	 * guarantees its pipes by construction. What the sweep buys is that the decision is made once
	 * rather than 36 times, and that the hand-written guards beside three of them are now redundant
	 * instead of load-bearing.
	 *
	 * Reading text out of a subprocess pipe is one operation. This asserts nobody spells it a
	 * thirty-sixth way, scanning every package source rather than a list, because the point of the
	 * sweep was that the list was never complete.
	 */
	it("goes through readPipeText rather than a hand-built Response", async () => {
		const sources = await collectPackageSources();

		const offenders = sources
			.filter(source =>
				/new Response\([A-Za-z_$][\w.$]*\.(?:stdout|stderr)(?: as ReadableStream(?:<Uint8Array>)?)?\)\.text\(\)/.test(
					source.text,
				),
			)
			.map(source => source.rel);

		expect(offenders).toEqual([]);
	});

	/**
	 * `ptree.ts` reads the same pipes as a blob, as JSON and as an ArrayBuffer, which are different
	 * operations and stay where they are. This pins that the sweep did not quietly convert them: a
	 * `readPipeText` where a caller wanted bytes would decode binary output as UTF-8 and corrupt it.
	 *
	 * Asserted as byte fidelity through a real pipe rather than as the spelling of the call. `FF FE`
	 * is not valid UTF-8, so it survives the round trip only if nothing decoded it; routing any of
	 * these readers through the text reader replaces both bytes with U+FFFD and the array stops
	 * matching. A rename or a reflow inside `ptree.ts` moves nothing here.
	 */
	it("left the non-text pipe readers alone, so binary output survives byte for byte", async () => {
		const raw = [0xff, 0xfe, 0x41];
		const emit = ["sh", "-c", "printf '\\377\\376A'"];

		expect([...(await spawn(emit).bytes())]).toEqual(raw);
		expect([...new Uint8Array(await spawn(emit).arrayBuffer())]).toEqual(raw);
		expect([...new Uint8Array(await (await spawn(emit).blob()).arrayBuffer())]).toEqual(raw);
	});

	/** And `json()` hands back parsed data, not the text of it, which a text reader could not do. */
	it("parses JSON off the pipe", async () => {
		expect(await spawn(["sh", "-c", `printf '{"ok":true,"n":2}'`]).json()).toEqual({ ok: true, n: 2 });
	});
});
