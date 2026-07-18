import { describe, expect, it } from "bun:test";
import { postmortem } from "@veyyon/utils";

/**
 * Contract for issue #2997: an EPIPE rejection from an IPC `send()` to a worker
 * subprocess (`syscall: "send"`) must be recognizable as a non-fatal, optional-
 * subsystem failure so the global `unhandledRejection` handler can swallow it
 * instead of terminating the session. Each predicate must be narrow: a bare
 * EPIPE matches neither, and the two syscall shapes route to different
 * handling — IPC `send` is swallowed (worker self-recovers), stdio `write`
 * exits quietly with code 0 (`veyyon … | head` closed the pipe; standard Unix
 * teardown, not a crash).
 */
function makeErr(props: { code?: string; syscall?: string; message?: string }): Error {
	const err = new Error(props.message ?? "broken pipe");
	Object.assign(err, { code: props.code, syscall: props.syscall });
	return err;
}

describe("postmortem.isIpcSendEpipe", () => {
	it("matches EPIPE with syscall 'send' (worker IPC send)", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe(true);
	});

	it("does not match EPIPE from a stdin/stdout write (syscall 'write')", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe(false);
	});

	it("does not match a bare EPIPE without a syscall", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE" }))).toBe(false);
	});

	it("does not match a non-EPIPE error even with syscall 'send'", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "ENOENT", syscall: "send" }))).toBe(false);
	});

	it("does not match a plain Error with no code/syscall", () => {
		expect(postmortem.isIpcSendEpipe(new Error("boom"))).toBe(false);
	});

	it("does not match nullish/missing errno-style fields gracefully", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: undefined, syscall: undefined }))).toBe(false);
	});
});

describe("postmortem.isStdioWriteEpipe", () => {
	it("matches EPIPE with syscall 'write' (consumer closed our stdout/stderr)", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe(true);
	});

	it("does not match EPIPE from an IPC send", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe(false);
	});

	it("does not match a bare EPIPE without a syscall", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EPIPE" }))).toBe(false);
	});

	it("does not match a non-EPIPE write error", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EIO", syscall: "write" }))).toBe(false);
	});
});
