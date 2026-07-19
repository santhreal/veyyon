import { describe, expect, it } from "bun:test";
import { AbortError, combineSignals, type Exception, exec, NonZeroExitError, spawn, TimeoutError } from "../src/ptree";

// ptree wraps Bun.spawn with captured stderr, a normalized exit model, and
// abort/timeout integration. Tests drive real short-lived POSIX commands
// (echo/cat/sh -c) so every assertion checks observed subprocess behavior, not
// a mock. Cancelled processes are killed via @veyyon/natives, so the sleeps
// below terminate in milliseconds.

describe("exec — success and output capture", () => {
	it("captures stdout, exit code, and ok for a zero-exit command", async () => {
		const r = await exec(["echo", "hello world"]);
		expect(r.stdout).toBe("hello world\n");
		expect(r.exitCode).toBe(0);
		expect(r.ok).toBe(true);
		expect(r.exitError).toBeUndefined();
	});

	it("feeds `input` to the child's stdin", async () => {
		const r = await exec(["cat"], { input: "piped payload" });
		expect(r.stdout).toBe("piped payload");
		expect(r.ok).toBe(true);
	});

	it("captures stderr separately from stdout", async () => {
		const r = await exec(["sh", "-c", "echo out; echo problem >&2; exit 0"]);
		expect(r.stdout).toBe("out\n");
		expect(r.stderr).toBe("problem\n");
		expect(r.ok).toBe(true);
	});
});

describe("exec — nonzero exit", () => {
	it("surfaces a NonZeroExitError in the result when allowNonZero is set", async () => {
		const r = await exec(["sh", "-c", "echo o; echo e >&2; exit 5"], { allowNonZero: true });
		expect(r.exitCode).toBe(5);
		expect(r.ok).toBe(false);
		expect(r.stdout).toBe("o\n");
		expect(r.exitError).toBeInstanceOf(NonZeroExitError);
		expect(r.exitError?.exitCode).toBe(5);
		expect(r.exitError?.stderr).toBe("e\n");
		expect(r.exitError?.aborted).toBe(false);
	});

	it("throws NonZeroExitError by default", async () => {
		let caught: unknown;
		try {
			await exec(["sh", "-c", "exit 7"]);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(NonZeroExitError);
		expect((caught as NonZeroExitError).exitCode).toBe(7);
	});
});

describe("exec — cancellation", () => {
	it("returns an AbortError result when an already-aborted signal is passed and allowAbort is set", async () => {
		const child = spawn(["sh", "-c", "sleep 2"], { signal: AbortSignal.abort() });
		child.exited.catch(() => {});
		const r = await child.wait({ allowAbort: true });
		expect(r.ok).toBe(false);
		expect(r.exitCode).toBeNull();
		expect(r.exitError).toBeInstanceOf(AbortError);
		expect(r.exitError?.aborted).toBe(true);
	});

	it("throws the AbortError when allowAbort is not set", async () => {
		let caught: unknown;
		try {
			await exec(["sh", "-c", "sleep 2"], { signal: AbortSignal.abort() });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(AbortError);
		expect((caught as AbortError).aborted).toBe(true);
	});

	it("times out with a TimeoutError after the deadline", async () => {
		const child = spawn(["sh", "-c", "sleep 2"], { timeout: 60 });
		// Pre-attach so the kill-triggered rejection is never momentarily unhandled
		// while wait() is still draining stdout/stderr.
		child.exited.catch(() => {});
		const r = await child.wait({ allowAbort: true });
		expect(r.exitError).toBeInstanceOf(TimeoutError);
		expect(r.exitError?.aborted).toBe(true);
	});

	it("aborts mid-flight when a live signal fires", async () => {
		const controller = new AbortController();
		const child = spawn(["sh", "-c", "sleep 2"], { signal: controller.signal });
		child.exited.catch(() => {});
		controller.abort();
		const r = await child.wait({ allowAbort: true });
		expect(r.exitError).toBeInstanceOf(AbortError);
		expect(r.exitError?.aborted).toBe(true);
	});
});

describe("spawn — ChildProcess helpers", () => {
	it("text() resolves stdout for a clean exit", async () => {
		// text() awaits the exit, so no explicit drain is needed.
		expect(await spawn(["echo", "streamed"]).text()).toBe("streamed\n");
	});

	it("text() throws on a nonzero exit but nothrow() suppresses it and still returns stdout", async () => {
		let threw = false;
		try {
			await spawn(["sh", "-c", "exit 4"]).text();
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(await spawn(["sh", "-c", "echo partial; exit 4"]).nothrow().text()).toBe("partial\n");
	});

	it("json() parses stdout as JSON", async () => {
		const child = spawn(["echo", '{"answer":42,"nested":[1,2]}']);
		const parsed = await child.json();
		await child.exited.catch(() => {});
		expect(parsed).toEqual({ answer: 42, nested: [1, 2] });
	});

	it("bytes() normalizes stdout to a Uint8Array", async () => {
		const child = spawn(["echo", "abc"]);
		const bytes = await child.bytes();
		await child.exited.catch(() => {});
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(bytes)).toBe("abc\n");
	});

	it("exposes a positive pid and latches exitCode after exit", async () => {
		const child = spawn(["echo", "x"]);
		expect(typeof child.pid).toBe("number");
		expect(child.pid).toBeGreaterThan(0);
		await child.text();
		expect(child.exitCode).toBe(0);
	});
});

describe("combineSignals", () => {
	it("returns undefined when given no signals or only null/undefined", () => {
		expect(combineSignals()).toBeUndefined();
		expect(combineSignals(null, undefined)).toBeUndefined();
	});

	it("returns the sole signal unchanged when exactly one is live", () => {
		const s = new AbortController().signal;
		expect(combineSignals(null, s, undefined)).toBe(s);
	});

	it("short-circuits to an already-aborted signal without allocating a combined one", () => {
		const live = new AbortController().signal;
		const aborted = AbortSignal.abort();
		expect(combineSignals(live, aborted)).toBe(aborted);
	});

	it("combines multiple live signals so aborting any one aborts the result", () => {
		const a = new AbortController();
		const b = new AbortController();
		const combined = combineSignals(a.signal, b.signal);
		expect(combined).toBeDefined();
		expect(combined?.aborted).toBe(false);
		b.abort();
		expect(combined?.aborted).toBe(true);
	});
});

describe("exception classes", () => {
	it("NonZeroExitError carries exitCode/stderr and is not aborted", () => {
		const e: Exception = new NonZeroExitError(3, "boom");
		expect(e.exitCode).toBe(3);
		expect(e.stderr).toBe("boom");
		expect(e.aborted).toBe(false);
		expect(e.name).toBe("NonZeroExitError");
		expect(e.message).toContain("code 3");
	});

	it("AbortError is aborted with exit code -1", () => {
		const e = new AbortError(new Error("cancel"), "tail");
		expect(e.aborted).toBe(true);
		expect(e.exitCode).toBe(-1);
		expect(e.message).toContain("cancel");
	});

	it("TimeoutError is an AbortError whose message reports the elapsed seconds", () => {
		const e = new TimeoutError(2000, "tail");
		expect(e).toBeInstanceOf(AbortError);
		expect(e.aborted).toBe(true);
		expect(e.message).toContain("Timed out after 2s");
	});
});
