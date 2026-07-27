/**
 * A session's disposal releases EVERY owner-scoped subsystem, even when one of them throws.
 *
 * WHY THIS SUITE EXISTS. `agent-session.dispose()` used to release owner-scoped resources by
 * naming four functions in a row:
 *
 *     await disposeKernelSessionsByOwner(ownerId);       // Python
 *     await disposeRubyKernelSessionsByOwner(ownerId);
 *     await disposeJuliaKernelSessionsByOwner(ownerId);
 *     await disposeVmContextsByOwner(ownerId);           // JS eval contexts
 *
 * Four bare `await`s in sequence: the first one to throw skipped the other three AND the browser
 * tab release that followed them. A single Python kernel that would not close therefore leaked
 * the Ruby kernels, the Julia kernels, the JS eval subprocess and every Chromium tab the session
 * had opened, while the operator saw one error and no mention of the leaks. Disposal is precisely
 * the path where one failure must not cancel the rest, and it was the path with no isolation at
 * all.
 *
 * The registry replaces those four calls. These tests are about the CONTRACT that makes it safe
 * to remove the hardcoded list: everyone runs, order does not depend on module load order,
 * failures are reported rather than swallowed, and a subsystem cannot register itself twice.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
	disposeOwnedResources,
	registeredOwnedResourceDisposers,
	registerOwnedResourceDisposer,
} from "@veyyon/coding-agent/session/owned-resources";

/** Register under a test-only prefix so a real subsystem's entry is never replaced. */
const PREFIX = "test-owned-resource:";

function name(suffix: string): string {
	return `${PREFIX}${suffix}`;
}

/** Neutralize any entry this suite added, so the cases stay independent of each other. */
function clearTestDisposers(): void {
	for (const registered of registeredOwnedResourceDisposers()) {
		if (registered.startsWith(PREFIX)) {
			registerOwnedResourceDisposer({ scope: "eval-kernel-owner", name: registered, dispose: async () => {} });
		}
	}
}

beforeEach(clearTestDisposers);

describe("disposeOwnedResources", () => {
	/**
	 * The bug, stated directly: a throwing disposer must not cost the ones behind it.
	 *
	 * Asserted on WHICH disposers ran, not on a count, because the failure mode was specifically
	 * the tail of the list being skipped. The thrower is registered first by name so the ordering
	 * below puts it ahead of the other two.
	 */
	it("runs every disposer even when an earlier one throws", async () => {
		const ran: string[] = [];
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("a-throws"),
			dispose: async () => {
				ran.push("a");
				throw new Error("kernel would not close");
			},
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("b"),
			dispose: async () => void ran.push("b"),
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("c"),
			dispose: async () => void ran.push("c"),
		});

		await expect(disposeOwnedResources("eval-kernel-owner", "owner-1")).rejects.toThrow(/owner-1/);

		expect(ran).toEqual(["a", "b", "c"]);
	});

	/**
	 * The failure is REPORTED, not swallowed. Silently completing would be worse than the original
	 * bug: cleanup would appear to succeed while a kernel stayed alive.
	 */
	it("rethrows every failure together as an AggregateError", async () => {
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("a-throws"),
			dispose: async () => {
				throw new Error("python refused");
			},
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("b"),
			dispose: async () => {},
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("c-throws"),
			dispose: async () => {
				throw new Error("julia refused");
			},
		});

		const thrown = await disposeOwnedResources("eval-kernel-owner", "owner-2").catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(AggregateError);
		const aggregate = thrown as AggregateError;
		expect(aggregate.errors.map((error: Error) => error.message)).toEqual(["python refused", "julia refused"]);
		expect(aggregate.message).toContain("owner-2");
	});

	/** The ordinary path stays quiet: nothing threw, so nothing is reported. */
	it("resolves when every disposer succeeds", async () => {
		const ran: string[] = [];
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("a"),
			dispose: async () => void ran.push("a"),
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("b"),
			dispose: async () => void ran.push("b"),
		});

		await disposeOwnedResources("eval-kernel-owner", "owner-3");

		expect(ran).toEqual(["a", "b"]);
	});

	/**
	 * Order is by NAME, never by registration order.
	 *
	 * Registration happens when a module loads, and which modules a session loaded depends on
	 * which tools it happened to use. If disposal order followed that, the sequence would differ
	 * run to run and a bug that only reproduces in one order would be unreproducible.
	 */
	it("disposes in name order regardless of registration order", async () => {
		const ran: string[] = [];
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("zebra"),
			dispose: async () => void ran.push("zebra"),
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("alpha"),
			dispose: async () => void ran.push("alpha"),
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("middle"),
			dispose: async () => void ran.push("middle"),
		});

		await disposeOwnedResources("eval-kernel-owner", "owner-4");

		expect(ran).toEqual(["alpha", "middle", "zebra"]);
	});

	/**
	 * The owner id reaches every disposer verbatim.
	 *
	 * The whole mechanism is owner-scoped: a subsystem walks its module-global map and touches
	 * only what this session created. An id that arrived mangled, or defaulted, would release
	 * another session's kernels.
	 */
	it("passes the owner id through to every disposer unchanged", async () => {
		const seen: string[] = [];
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("a"),
			dispose: async owner => void seen.push(owner),
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("b"),
			dispose: async owner => void seen.push(owner),
		});

		await disposeOwnedResources("eval-kernel-owner", "session-7f3a::eval");

		expect(seen).toEqual(["session-7f3a::eval", "session-7f3a::eval"]);
	});

	/** A disposer that reports nothing is as valid as one that counts; neither may break the loop. */
	it("accepts a disposer that returns nothing and one that returns a count", async () => {
		const ran: string[] = [];
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("a"),
			dispose: async () => void ran.push("void"),
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("b"),
			dispose: async () => {
				ran.push("count");
				return 3;
			},
		});

		await disposeOwnedResources("eval-kernel-owner", "owner-5");

		expect(ran).toEqual(["void", "count"]);
	});

	/** Nothing registered is not an error: a session that ran no eval has nothing to release. */
	it("resolves when no disposer is registered for a subsystem", async () => {
		await disposeOwnedResources("eval-kernel-owner", "owner-6");
	});

	/**
	 * A scope is a filter, not a label.
	 *
	 * A session holds two owner ids that are NOT interchangeable: the eval-kernel owner id, which
	 * survives a session handing kernel ownership on, and the session id itself, which is what
	 * `acquireTab` stamps on a browser tab. Running a session-scoped disposer with the eval owner
	 * id would match nothing and report success, which is the silent-leak shape this whole registry
	 * exists to prevent, so the filter is asserted in both directions.
	 */
	it("runs only the disposers registered under the scope it was called with", async () => {
		const ran: string[] = [];
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("kernel"),
			dispose: async () => void ran.push("kernel"),
		});
		registerOwnedResourceDisposer({
			scope: "session",
			name: name("session-scoped"),
			dispose: async () => void ran.push("session-scoped"),
		});

		await disposeOwnedResources("eval-kernel-owner", "owner-9");
		expect(ran).toEqual(["kernel"]);

		await disposeOwnedResources("session", "owner-9");
		expect(ran).toEqual(["kernel", "session-scoped"]);
	});

	/**
	 * `timeoutMs` bounds a disposer that hangs, and the timeout is a REPORTED failure.
	 *
	 * Browser teardown talks to a live CDP connection, and a close that never returns must not stall
	 * `/exit` (issue #3963). Before the registry that bound lived in an inline `withTimeout` at the
	 * one call site; it is now a property of the disposer, so a subsystem that needs the bound
	 * cannot be wired up without it. The later disposer proves the timeout does not eat the tail
	 * either.
	 */
	it("bounds a hanging disposer and keeps going", async () => {
		const ran: string[] = [];
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("a-hangs"),
			timeoutMs: 20,
			dispose: () =>
				new Promise<void>(() => {
					ran.push("a-started");
				}),
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("b"),
			dispose: async () => void ran.push("b"),
		});

		const thrown = await disposeOwnedResources("eval-kernel-owner", "owner-10").catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toHaveLength(1);
		expect(ran).toEqual(["a-started", "b"]);
	});
});

describe("registerOwnedResourceDisposer", () => {
	/**
	 * Re-registering a name REPLACES the entry.
	 *
	 * A module can be evaluated twice (test isolation, a re-import through a different specifier),
	 * and two entries under one name would dispose the same subsystem twice. For a kernel map
	 * that is merely wasteful; for anything that counts what it released it is a wrong number.
	 */
	it("replaces an entry registered under the same name rather than adding a second", async () => {
		let calls = 0;
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("dup"),
			dispose: async () => void calls++,
		});
		registerOwnedResourceDisposer({
			scope: "eval-kernel-owner",
			name: name("dup"),
			dispose: async () => void calls++,
		});

		await disposeOwnedResources("eval-kernel-owner", "owner-8");

		expect(calls).toBe(1);
		expect(registeredOwnedResourceDisposers().filter(entry => entry === name("dup"))).toHaveLength(1);
	});
});

describe("the real subsystems", () => {
	/**
	 * The five subsystems that used to be named by hand in `dispose()` really do register.
	 *
	 * Load-time registration is what makes removing the hardcoded list safe, and the failure mode
	 * if a module forgets to register is INVISIBLE: cleanup reports success and the kernel stays
	 * alive. So this asserts the names, by importing each module exactly as a session would.
	 */
	it("register their disposers when their modules load", async () => {
		await import("@veyyon/coding-agent/eval/py/executor");
		await import("@veyyon/coding-agent/eval/rb/executor");
		await import("@veyyon/coding-agent/eval/jl/executor");
		await import("@veyyon/coding-agent/eval/js/context-manager");
		await import("@veyyon/coding-agent/tools/browser/tab-supervisor");

		const registered = registeredOwnedResourceDisposers();

		expect(registered).toContain("python-kernels");
		expect(registered).toContain("ruby-kernels");
		expect(registered).toContain("julia-kernels");
		expect(registered).toContain("js-eval-contexts");
		expect(registered).toContain("browser-tabs");
	});
});
