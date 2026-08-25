/**
 * `DeferredDiagnostics.begin(path)` is the mutation ticket. A second begin
 * for the same path must abort the first fetch (the LSP snapshot it would
 * return is about a file that is already being mutated again) and bump the
 * version so an in-flight callback from the first ticket is marked stale.
 *
 * Without that:
 *
 *   - the first callback injects diagnostics for version N after version
 *     N+1 has already been written, and the operator sees errors that the
 *     later edit already fixed
 *   - the first AbortController is leaked; a late fetch still runs
 *
 * `isStale` is the only signal the UI has. It has to answer true for the
 * superseded ticket and false for the live one, including when the session
 * does not provide `bumpFileMutationVersion` and the class falls back to
 * its own counter.
 */
import { describe, expect, it } from "bun:test";
import { DeferredDiagnostics } from "@veyyon/coding-agent/lsp/deferred-diagnostics";
import type { FileDiagnosticsResult } from "@veyyon/coding-agent/lsp";
import { makeToolSession } from "../helpers/tool-session";

function diag(message: string): FileDiagnosticsResult {
	return { messages: [message], summary: "1 error(s)", errored: true };
}

describe("a second begin aborts the first ticket and invalidates its inject", () => {
	it("aborts the first signal when begin is called again for the same path", () => {
		// begin() only aborts a controller it stored in `#pendingFetches`, and
		// that map is filled in finalize(undefined). A second begin before
		// finalize therefore leaves the first fetch running. The version bump
		// still happens (the inject-is-stale case below), but the in-flight
		// LSP round-trip is not cancelled. Stays red until begin tracks the
		// live controller, not only the pending-fetch one.
		const session = makeToolSession({ queueDeferredDiagnostics: () => {} });
		const deferred = new DeferredDiagnostics(session, false);
		const first = deferred.begin("/repo/a.ts");
		expect(first.signal.aborted).toBe(false);
		const second = deferred.begin("/repo/a.ts");
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
	});

	it("the live ticket's inject is not stale, the superseded ticket's inject is", () => {
		const seen: boolean[] = [];
		const session = makeToolSession({
			queueDeferredDiagnostics: entry => {
				seen.push(entry.isStale());
			},
		});
		const deferred = new DeferredDiagnostics(session, false);
		const first = deferred.begin("/repo/a.ts");
		const second = deferred.begin("/repo/a.ts");
		first.onDeferredDiagnostics(diag("from-first"));
		second.onDeferredDiagnostics(diag("from-second"));
		expect(seen).toEqual([true, false]);
	});

	it("a third begin on a different path does not stale the live ticket", () => {
		const byPath: Record<string, boolean> = {};
		const session = makeToolSession({
			queueDeferredDiagnostics: entry => {
				byPath[entry.path] = entry.isStale();
			},
		});
		const deferred = new DeferredDiagnostics(session, false);
		const a = deferred.begin("/repo/a.ts");
		const b = deferred.begin("/repo/b.ts");
		a.onDeferredDiagnostics(diag("a"));
		b.onDeferredDiagnostics(diag("b"));
		expect(byPath["/repo/a.ts"]).toBe(false);
		expect(byPath["/repo/b.ts"]).toBe(false);
	});
});
