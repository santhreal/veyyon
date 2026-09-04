import { describe, expect, it } from "bun:test";
import { decideTerminalWriteFailure, terminalWriteErrorCode } from "@veyyon/tui/terminal";

// REGRESSION: ProcessTerminal used to latch `#dead = true` on the FIRST write
// error of any kind, then no-op every subsequent write for the rest of the
// process. A single transient failure — stdout backpressure (`EAGAIN`), a
// momentary PTY `EIO`, an `EINTR` — therefore blanked the entire TUI for the
// whole session with no recovery, which reads to the user as "veyyon launched
// but the screen is frozen/blank". The fix splits write failures into FATAL
// (the terminal is genuinely gone: latch off once, loudly) and TRANSIENT (keep
// rendering; the next full-frame paint retries), with a consecutive-failure
// backstop so a device that fails forever without a fatal code still latches.
// These lock that policy at the exact boundaries so it can never silently
// regress back to "one hiccup bricks the UI".

function withCode(code: string): Error {
	const err = new Error(`simulated ${code}`);
	(err as Error & { code: string }).code = code;
	return err;
}

describe("terminalWriteErrorCode", () => {
	it("extracts a libuv-style string code from an Error-like value", () => {
		expect(terminalWriteErrorCode(withCode("EPIPE"))).toBe("EPIPE");
	});

	it("returns undefined when there is no code, or the value is not an object", () => {
		expect(terminalWriteErrorCode(new Error("no code"))).toBeUndefined();
		expect(terminalWriteErrorCode("EPIPE")).toBeUndefined();
		expect(terminalWriteErrorCode(null)).toBeUndefined();
		expect(terminalWriteErrorCode(undefined)).toBeUndefined();
		expect(terminalWriteErrorCode({ code: 32 })).toBeUndefined(); // non-string code
	});
});

describe("decideTerminalWriteFailure — fatal codes latch immediately", () => {
	// The terminal (or piped reader) is gone; every future write fails the same
	// way, so latch off on the very first failure regardless of the counter.
	for (const code of ["EPIPE", "EBADF", "ENXIO", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) {
		it(`treats ${code} as disable-fatal even at the first failure`, () => {
			expect(decideTerminalWriteFailure(withCode(code), 1)).toBe("disable-fatal");
		});
	}

	it("stays disable-fatal even far below the exhaustion backstop", () => {
		// A fatal code must never be reclassified as retry just because the count is
		// low — the whole point is it latches without waiting for a streak.
		expect(decideTerminalWriteFailure(withCode("EPIPE"), 1)).toBe("disable-fatal");
		expect(decideTerminalWriteFailure(withCode("EPIPE"), 3)).toBe("disable-fatal");
	});
});

describe("decideTerminalWriteFailure — transient codes retry until the backstop", () => {
	// Backpressure and momentary I/O errors are recoverable: keep rendering so the
	// next full-frame paint retries. The UI must not disable on any single one.
	for (const code of ["EAGAIN", "EWOULDBLOCK", "EINTR", "EIO"]) {
		it(`treats ${code} as retry for the first several consecutive failures`, () => {
			expect(decideTerminalWriteFailure(withCode(code), 1)).toBe("retry");
			expect(decideTerminalWriteFailure(withCode(code), 7)).toBe("retry");
		});
	}

	it("retries an unknown/absent code below the threshold", () => {
		expect(decideTerminalWriteFailure(new Error("no code"), 1)).toBe("retry");
		expect(decideTerminalWriteFailure({}, 5)).toBe("retry");
	});

	it("latches disable-exhausted only once the consecutive count reaches the backstop", () => {
		// The boundary is exactly 8: 7 in a row still retries (a success in between
		// resets the count), the 8th consecutive failure with no success latches.
		expect(decideTerminalWriteFailure(withCode("EAGAIN"), 7)).toBe("retry");
		expect(decideTerminalWriteFailure(withCode("EAGAIN"), 8)).toBe("disable-exhausted");
		expect(decideTerminalWriteFailure(withCode("EAGAIN"), 9)).toBe("disable-exhausted");
	});

	it("applies the exhaustion backstop to an unknown code too, not only known transient ones", () => {
		expect(decideTerminalWriteFailure(new Error("mystery"), 8)).toBe("disable-exhausted");
	});
});
