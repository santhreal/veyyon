/**
 * A pipe nobody writes to must not hold a run hostage forever. A pipe that IS writing must never be cut off.
 *
 * WHY THIS SUITE EXISTS. `veyyon -p "prompt"` reads piped stdin so `cat notes.md | veyyon -p "summarise"`
 * works, and reading a pipe means waiting for EOF. A supervisor, CI runner or wrapper that spawns the CLI
 * with an INHERITED pipe it never writes to and never closes never sends that EOF, so startup blocked
 * forever: one dim notice after a second, then nothing, with the prompt sitting unused on the command line.
 * It reproduces from any parent that keeps a pipe open, which is most of them -- exactly the environments
 * where nobody is watching a terminal to hit ctrl+c.
 *
 * The fix cannot be a plain timeout. Truncating a slow producer would silently drop half the prompt, which
 * is worse than hanging: the model answers about content the user believes it read. So the bound applies
 * ONLY before the first byte, and only when the command line already carries a prompt, so there is
 * something to run without the pipe. Once any byte arrives the wait is unbounded again.
 *
 * Both halves are asserted here, and the second is the one a future "simplification" into a single overall
 * deadline would break: a producer whose LAST chunk arrives well after the deadline must still be read in
 * full.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readStdinWithFirstByteBound } from "@veyyon/coding-agent/main";

const savedWait = process.env.VEYYON_PIPED_STDIN_WAIT_MS;
let stderr: string[];
const realWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
	stderr = [];
	// The give-up path reports itself on stderr, and that report is part of the contract: a run that
	// dropped the piped half of its input silently would be a silent fallback.
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stderr.write;
});

afterEach(() => {
	process.stderr.write = realWrite;
	if (savedWait === undefined) delete process.env.VEYYON_PIPED_STDIN_WAIT_MS;
	else process.env.VEYYON_PIPED_STDIN_WAIT_MS = savedWait;
});

/** A stream that yields `chunks`, each after its own delay, then ends. */
function producer(chunks: Array<{ text: string; afterMs: number }>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				if (chunk.afterMs > 0) await Bun.sleep(chunk.afterMs);
				controller.enqueue(encoder.encode(chunk.text));
			}
			controller.close();
		},
	});
}

/** A stream that never yields anything and never ends: the pipe that caused the hang. */
function silentForever(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start() {
			// Deliberately no enqueue and no close.
		},
	});
}

describe("reading piped stdin when a prompt was already given", () => {
	/** The ordinary pipe: everything written comes back, exactly. */
	it("returns the whole piped text", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "1000";

		const text = await readStdinWithFirstByteBound(true, producer([{ text: "line one\nline two\n", afterMs: 0 }]));

		expect(text).toBe("line one\nline two\n");
		expect(stderr).toEqual([]);
	});

	/**
	 * The regression. Nothing arrives, nothing ever will, and the run has a prompt in hand: it proceeds
	 * rather than blocking, and says so, naming the escape hatch.
	 */
	it("gives up on a pipe that never writes, and reports it", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "150";

		const text = await readStdinWithFirstByteBound(true, silentForever());

		expect(text).toBeUndefined();
		const said = stderr.join("");
		expect(said).toContain("No piped input arrived");
		expect(said).toContain("VEYYON_PIPED_STDIN_WAIT_MS=0");
	});

	/**
	 * A producer that is merely slow to start is still read. Without this the bound would turn every
	 * `slow-command | veyyon -p "…"` into a dropped input, which is the failure mode a plain timeout has.
	 */
	it("waits for a producer that is slow to start", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "500";

		const text = await readStdinWithFirstByteBound(true, producer([{ text: "eventually", afterMs: 120 }]));

		expect(text).toBe("eventually");
		expect(stderr).toEqual([]);
	});

	/**
	 * THE assertion that a single overall deadline would fail. The first chunk beats the bound, the last
	 * arrives long after it, and the result must still be complete: once the producer has spoken, the wait
	 * is unbounded, because truncating it would answer about content the user believes was read.
	 */
	it("keeps reading past the bound once the first byte has arrived", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "100";

		const text = await readStdinWithFirstByteBound(
			true,
			producer([
				{ text: "first", afterMs: 10 },
				{ text: "-second", afterMs: 250 },
				{ text: "-third", afterMs: 250 },
			]),
		);

		expect(text).toBe("first-second-third");
		expect(stderr).toEqual([]);
	});

	/**
	 * A multi-byte character split across two chunks must decode once over the whole buffer. Decoding per
	 * chunk turns the boundary into a replacement character, which is silent corruption of the user's input.
	 */
	it("decodes a character split across chunk boundaries", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "500";
		const encoded = new TextEncoder().encode("héllo — ok");
		const split = encoded.byteLength - 4;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoded.slice(0, split));
				controller.enqueue(encoded.slice(split));
				controller.close();
			},
		});

		expect(await readStdinWithFirstByteBound(true, stream)).toBe("héllo — ok");
	});
});

describe("reading piped stdin when the pipe is the only input", () => {
	/**
	 * No prompt argument means the pipe IS the prompt, so there is nothing to run without it and waiting is
	 * the only correct behaviour. This is why the bound is conditional rather than global.
	 */
	it("waits indefinitely rather than giving up", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "50";
		const slow = producer([{ text: "the prompt itself", afterMs: 200 }]);

		const text = await readStdinWithFirstByteBound(false, slow);

		expect(text).toBe("the prompt itself");
		expect(stderr).toEqual([]);
	});

	/** And `VEYYON_PIPED_STDIN_WAIT_MS=0` restores the old wait-forever behaviour even with a prompt. */
	it("waits indefinitely when the bound is disabled", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "0";
		const slow = producer([{ text: "late but wanted", afterMs: 200 }]);

		const text = await readStdinWithFirstByteBound(true, slow);

		expect(text).toBe("late but wanted");
		expect(stderr).toEqual([]);
	});

	/** An invalid override falls back to the built-in bound rather than disabling it by accident. */
	it("ignores an unparseable bound", async () => {
		process.env.VEYYON_PIPED_STDIN_WAIT_MS = "not-a-number";

		const text = await readStdinWithFirstByteBound(true, producer([{ text: "fine", afterMs: 0 }]));

		expect(text).toBe("fine");
	});
});
