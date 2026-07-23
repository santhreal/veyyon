/**
 * Guard: the TUI slash-command host reads a NAMED SLICE of the interactive
 * context, never the whole 215-member `InteractiveModeContext` (H1-77).
 *
 * `TuiSlashCommandRuntime.ctx` used to be typed as the full interface. Nothing
 * but the real TUI can construct that, so every slash-command test had to reach
 * it through `as unknown as InteractiveModeContext`, and each such stub was
 * unchecked against the members it claimed to supply. Naming the exact surface
 * the host touches (`TuiSlashCommandHostContext`, 78 direct reads plus the
 * collab sub-slices it constructs) makes the dependency legible and lets a test
 * build a runtime from a `Pick` with no cast.
 *
 * Two kinds of check below, because the contract is partly a type property and
 * partly a source-shape property:
 *
 * 1. Type-level. The `runtime` binding assigns a `TuiSlashCommandHostContext`
 *    into `TuiSlashCommandRuntime.ctx` with NO cast — if the field regressed to
 *    the full interface, or the slice grew a member the interface lacks, this
 *    stops compiling under tsgo (which checks the test tree). The
 *    `@ts-expect-error` lines assert three input-controller-only members are
 *    genuinely ABSENT from the slice; if the slice were quietly widened back to
 *    the whole interface, the errors would vanish and tsgo would flag the now
 *    unused `@ts-expect-error`.
 * 2. Source-shape. `types.ts` must keep typing the field as the slice and keep
 *    composing the collab sub-slices, because `/collab` builds a
 *    `CollabHost`/`CollabGuestLink` from the whole `ctx` and dropping the
 *    compose would silently lose that transitive surface. Nothing at runtime
 *    can observe the type, so the source is scanned directly.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TuiSlashCommandHostContext, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

// --- Type-level lock (checked by tsgo, never executed) -----------------------
// This function is declared for the type checker and never called; its body is
// where the compile-time contract lives. Keeping it uncalled means the `declare
// const` free variable is never dereferenced at runtime.
function _tuiSlashHostContextTypeContract(host: TuiSlashCommandHostContext): void {
	// A value typed as the slice is assignable to the runtime's ctx with no cast.
	// This is the whole point of naming the slice: the runtime is constructible.
	const runtime: TuiSlashCommandRuntime = { ctx: host };
	void runtime;

	// These members live on `InteractiveModeContext` but are read only by the
	// input controller, never by a slash-command handler, so they must NOT be on
	// the slice. If the slice were widened back to the full interface these
	// accesses would succeed and the `@ts-expect-error` would itself become the error.
	// @ts-expect-error handleBashCommand is input-controller-only, absent from the slice
	void host.handleBashCommand;
	// @ts-expect-error keybindings is input-controller-only, absent from the slice
	void host.keybindings;
	// @ts-expect-error showModelCycleTrack is input-controller-only, absent from the slice
	void host.showModelCycleTrack;
}
void _tuiSlashHostContextTypeContract;

// --- Source-shape lock -------------------------------------------------------

const TYPES_SRC = path.resolve(import.meta.dir, "../../src/slash-commands/types.ts");

describe("TuiSlashCommandRuntime narrows the interactive context (H1-77)", () => {
	const source = fs.readFileSync(TYPES_SRC, "utf8");

	it("reads the real types.ts source, so the scans below mean something", () => {
		// Anti-vacuity: the collapse of any read below to a trivial pass is caught here.
		expect(source).toContain("export interface TuiSlashCommandRuntime");
		expect(source.length).toBeGreaterThan(2_000);
	});

	it("types the runtime ctx as the named slice, not the full InteractiveModeContext", () => {
		// The exact regression this locks out: `ctx: InteractiveModeContext` inside
		// TuiSlashCommandRuntime, which forced the `as unknown as` casts.
		const runtimeBlock = source.slice(source.indexOf("export interface TuiSlashCommandRuntime"));
		const fieldLine = runtimeBlock.slice(0, runtimeBlock.indexOf("}"));
		expect(fieldLine).toContain("ctx: TuiSlashCommandHostContext");
		expect(fieldLine).not.toContain("ctx: InteractiveModeContext");
	});

	it("composes the collab sub-slices so /collab's transitive surface stays covered", () => {
		// `new CollabHost(ctx)` / `new CollabGuestLink(ctx)` need everything
		// CollabHostContext / CollabGuestContext require. Composing them (ONE PLACE)
		// keeps that in lockstep; re-listing members by hand would drift and break
		// /collab silently. Assert the compose is present.
		expect(source).toContain("export type TuiSlashCommandHostContext = CollabHostContext &");
		expect(source).toContain("CollabGuestContext &");
		expect(source).toContain("Pick<");
	});
});
