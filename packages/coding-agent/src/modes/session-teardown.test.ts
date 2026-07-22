import { describe, expect, it } from "bun:test";
import { postmortem } from "@veyyon/utils";
import { createSessionTeardown, type SessionTeardownDeps } from "./session-teardown";

/**
 * Signal-safe session teardown contract (issue #4080 + DATALOSS-SETTINGS). The
 * callback registered on `postmortem` for `SIGINT`/`SIGTERM`/`SIGHUP`/
 * `uncaughtException` must persist the in-progress editor draft, flush pending
 * settings, and emit the extension `session_shutdown` event (via
 * `session.dispose()`) — the same steps the TUI Ctrl+C keypress path performs.
 * Both paths funnel through `createSessionTeardown`, so exercising it directly
 * proves the acceptance criteria hold regardless of the trigger.
 */

/** A recording harness: default deps that log call order, overridable per test. */
interface Recorder {
	order: string[];
	draftSaved: string[];
	flushed: number;
	disposedReasons: Array<postmortem.Reason | undefined>;
	calls: { getDraft: number; beginDispose: number; saveDraft: number; flushSettings: number; dispose: number };
}

function makeDeps(overrides: Partial<SessionTeardownDeps> = {}): { deps: SessionTeardownDeps; rec: Recorder } {
	const rec: Recorder = {
		order: [],
		draftSaved: [],
		flushed: 0,
		disposedReasons: [],
		calls: { getDraft: 0, beginDispose: 0, saveDraft: 0, flushSettings: 0, dispose: 0 },
	};
	const deps: SessionTeardownDeps = {
		getDraftText: () => {
			rec.calls.getDraft++;
			rec.order.push("getDraftText");
			return "draft";
		},
		beginDispose: () => {
			rec.calls.beginDispose++;
			rec.order.push("beginDispose");
		},
		saveDraft: async text => {
			rec.calls.saveDraft++;
			rec.order.push("saveDraft");
			rec.draftSaved.push(text);
		},
		flushSettings: async () => {
			rec.calls.flushSettings++;
			rec.flushed++;
			rec.order.push("flushSettings");
		},
		disposeSession: async reason => {
			rec.calls.dispose++;
			rec.order.push("disposeSession");
			rec.disposedReasons.push(reason);
		},
		...overrides,
	};
	return { deps, rec };
}

describe("createSessionTeardown", () => {
	it("runs beginDispose, saveDraft, flushSettings, disposeSession in that exact order", async () => {
		const { deps, rec } = makeDeps({ getDraftText: () => "unsent draft" });
		const teardown = createSessionTeardown(deps);

		await teardown();

		// Settings must flush AFTER the draft is saved but BEFORE the (possibly long)
		// dispose, so a slow dispose or a second signal cannot strand the write.
		expect(rec.order).toEqual(["beginDispose", "saveDraft", "flushSettings", "disposeSession"]);
		expect(rec.draftSaved).toEqual(["unsent draft"]);
	});

	it("marks the session disposing before awaiting draft persistence", async () => {
		const order: string[] = [];
		const release = Promise.withResolvers<void>();

		const teardown = createSessionTeardown(
			makeDeps({
				getDraftText: () => {
					order.push("snapshot");
					return "draft";
				},
				beginDispose: () => {
					order.push("beginDispose");
				},
				saveDraft: async () => {
					order.push("saveDraft:start");
					await release.promise;
					order.push("saveDraft:done");
				},
				flushSettings: async () => {
					order.push("flushSettings");
				},
				disposeSession: async () => {
					order.push("disposeSession");
				},
			}).deps,
		);

		const running = teardown();
		expect(order).toEqual(["snapshot", "beginDispose", "saveDraft:start"]);
		release.resolve();
		await running;

		expect(order).toEqual([
			"snapshot",
			"beginDispose",
			"saveDraft:start",
			"saveDraft:done",
			"flushSettings",
			"disposeSession",
		]);
	});

	it("still disposes when saveDraft rejects — never leaves session_shutdown unemitted", async () => {
		const { deps, rec } = makeDeps({
			saveDraft: async () => {
				throw new Error("disk full");
			},
		});
		const teardown = createSessionTeardown(deps);

		await teardown();

		// A draft-write failure must not skip settings flush OR dispose.
		expect(rec.calls.flushSettings).toBe(1);
		expect(rec.calls.dispose).toBe(1);
	});

	it("passes the empty snapshot through so a stale sidecar is cleared on clean exit", async () => {
		const { deps, rec } = makeDeps({ getDraftText: () => "" });
		const teardown = createSessionTeardown(deps);

		await teardown();

		expect(rec.draftSaved).toEqual([""]);
	});

	it("memoizes: concurrent and repeat calls run the teardown exactly once", async () => {
		const release = Promise.withResolvers<void>();
		const { deps, rec } = makeDeps({
			disposeSession: async () => {
				rec.calls.dispose++;
				await release.promise;
			},
		});
		const teardown = createSessionTeardown(deps);

		// Kick off two concurrent invocations while the first is still awaiting
		// disposeSession — exactly what happens if a SIGTERM arrives mid-shutdown.
		const first = teardown();
		const second = teardown();
		release.resolve();
		await Promise.all([first, second]);

		// A third call after settlement must still be a no-op.
		await teardown();

		expect(rec.calls.getDraft).toBe(1);
		expect(rec.calls.saveDraft).toBe(1);
		expect(rec.calls.flushSettings).toBe(1);
		expect(rec.calls.dispose).toBe(1);
	});

	it("snapshots the draft text at first call — later editor mutations do not leak in", async () => {
		let editorText = "before";
		const { deps, rec } = makeDeps({ getDraftText: () => editorText });
		const teardown = createSessionTeardown(deps);

		const running = teardown();
		editorText = "after"; // A late edit must not overwrite the persisted draft.
		await running;

		expect(rec.draftSaved).toEqual(["before"]);
	});

	it("forwards the postmortem reason into disposeSession so signal exits record the real trigger", async () => {
		const { deps, rec } = makeDeps();
		const teardown = createSessionTeardown(deps);

		await teardown(postmortem.Reason.SIGTERM);

		expect(rec.disposedReasons).toEqual([postmortem.Reason.SIGTERM]);
	});

	it("keypress path passes no reason — dispose falls back to a normal exit record", async () => {
		const { deps, rec } = makeDeps();
		const teardown = createSessionTeardown(deps);

		await teardown();

		expect(rec.disposedReasons).toEqual([undefined]);
	});

	it("first call's reason wins: a later caller with a different reason awaits the same promise", async () => {
		const release = Promise.withResolvers<void>();
		const { deps, rec } = makeDeps({
			disposeSession: async reason => {
				rec.disposedReasons.push(reason);
				await release.promise;
			},
		});
		const teardown = createSessionTeardown(deps);

		// SIGTERM lands first; postmortem.quit(0)'s MANUAL pass arrives while the
		// teardown is still draining — it must not restart the run or mutate the reason.
		const first = teardown(postmortem.Reason.SIGTERM);
		const second = teardown(postmortem.Reason.MANUAL);
		release.resolve();
		await Promise.all([first, second]);

		expect(rec.disposedReasons).toEqual([postmortem.Reason.SIGTERM]);
	});
});

/**
 * DATALOSS-SETTINGS regression suite.
 *
 * `settings.set()` schedules a 100ms-debounced async write; `settings.flush()`
 * is the durability contract ("Call before exit to ensure all changes are
 * persisted"). Before this fix the interactive TUI and the shared signal
 * teardown disposed the session but NEVER flushed Settings, so a `/settings`
 * change made just before quitting was silently lost. These tests lock in that
 * every teardown path flushes settings, exactly once, resiliently, and before
 * the dispose — proving the same exit-durability the session record already has.
 */
describe("session teardown flushes settings on exit (DATALOSS-SETTINGS)", () => {
	it("flushes pending settings on a keypress (no-reason) teardown", async () => {
		// WHY: the plain `/exit` / Ctrl+C keypress path (reason undefined) is the most
		// common quit; a setting the user just toggled must reach disk before exit.
		const { deps, rec } = makeDeps();
		const teardown = createSessionTeardown(deps);

		await teardown();

		expect(rec.calls.flushSettings).toBe(1);
	});

	it("flushes pending settings on every catchable signal path (SIGINT/SIGTERM/SIGHUP/uncaughtException)", async () => {
		// WHY: a kernel signal must persist settings identically to a keypress — the
		// whole point of the shared teardown. Each reason gets a fresh teardown (a
		// real process only ever runs one), and each must flush exactly once.
		for (const reason of [
			postmortem.Reason.SIGINT,
			postmortem.Reason.SIGTERM,
			postmortem.Reason.SIGHUP,
			postmortem.Reason.UNCAUGHT_EXCEPTION,
		]) {
			const { deps, rec } = makeDeps();
			const teardown = createSessionTeardown(deps);

			await teardown(reason);

			expect(rec.calls.flushSettings, `reason=${reason}`).toBe(1);
			expect(rec.disposedReasons, `reason=${reason}`).toEqual([reason]);
		}
	});

	it("flushes settings even when saveDraft throws — a draft error cannot drop the settings write", async () => {
		// WHY: saveDraft and flushSettings are independent durability steps. A failing
		// draft write (disk full, permissions) must not skip persisting settings.
		const { deps, rec } = makeDeps({
			saveDraft: async () => {
				throw new Error("draft disk full");
			},
		});
		const teardown = createSessionTeardown(deps);

		await teardown();

		expect(rec.calls.flushSettings).toBe(1);
		expect(rec.calls.dispose).toBe(1);
	});

	it("a flushSettings rejection is swallowed and never aborts the disposal chain", async () => {
		// WHY: a settings-write error at teardown must not leak background jobs or skip
		// the `session_shutdown` event — dispose must still run (same contract as draft).
		const { deps, rec } = makeDeps({
			flushSettings: async () => {
				rec.calls.flushSettings++;
				throw new Error("settings disk full");
			},
		});
		const teardown = createSessionTeardown(deps);

		await expect(teardown()).resolves.toBeUndefined();
		expect(rec.calls.flushSettings).toBe(1);
		expect(rec.calls.dispose).toBe(1);
	});

	it("flushes settings BEFORE the (potentially long) dispose, so a slow dispose cannot strand the write", async () => {
		// WHY: dispose can block for up to SHUTDOWN_CONSOLIDATE_BUDGET_MS (mnemopi
		// consolidation). If settings flushed after dispose, a second signal or a
		// timeout during that window would lose the setting. Flush must precede dispose.
		const order: string[] = [];
		const disposeGate = Promise.withResolvers<void>();
		const teardown = createSessionTeardown(
			makeDeps({
				flushSettings: async () => {
					order.push("flushSettings");
				},
				disposeSession: async () => {
					order.push("dispose:start");
					await disposeGate.promise;
					order.push("dispose:done");
				},
			}).deps,
		);

		const running = teardown();
		// Let microtasks settle: flush should have completed and dispose parked.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["flushSettings", "dispose:start"]);
		disposeGate.resolve();
		await running;
		expect(order).toEqual(["flushSettings", "dispose:start", "dispose:done"]);
	});

	it("flushes settings exactly once across concurrent and repeat teardown calls", async () => {
		// WHY: a SIGTERM racing an in-flight Ctrl+C must not double-flush (harmless but
		// wasteful) nor skip the flush; the memoized run guarantees exactly one flush.
		const release = Promise.withResolvers<void>();
		const { deps, rec } = makeDeps({
			disposeSession: async () => {
				rec.calls.dispose++;
				await release.promise;
			},
		});
		const teardown = createSessionTeardown(deps);

		const a = teardown(postmortem.Reason.SIGINT);
		const b = teardown(postmortem.Reason.SIGTERM);
		release.resolve();
		await Promise.all([a, b]);
		await teardown(); // post-settlement no-op

		expect(rec.calls.flushSettings).toBe(1);
	});
});
