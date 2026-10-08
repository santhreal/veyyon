/**
 * A session whose only extensions are the product's own never evaluates the package barrel.
 *
 * WHY THIS SUITE EXISTS. `api.pi` is the whole package (`src/index.ts`), which re-exports every mode,
 * component and exporter. `extensibility/coding-agent-api.ts` loads it on demand so that a launch with
 * no author code never pays for it, and the custom tool and custom command loaders skip it when they
 * have no paths. Session creation still bound its own inline autoresearch extension through the
 * author path, which loaded the barrel on every `createAgentSession`: 54ms of session creation and
 * about 5 MiB of retained heap on a 13,470-message resume, and the HTML export's template and
 * tool-view bundle resident in print, RPC and ACP processes that never export.
 *
 * The check runs at the choke point, `createAgentSession`, in a fresh process, and reads the module
 * registry rather than a spy: any route that evaluates the barrel during session creation turns it
 * red, whichever factory or loader it goes through. The author arm is the positive control. It proves
 * the probe sees the barrel when it is loaded, and it pins the contract the change must keep: an
 * author's inline extension still receives the real namespace as `api.pi`. Both arms assert the
 * builtin autoresearch commands registered, so the first arm cannot pass by binding nothing.
 *
 * Not caught: a builtin factory that reaches the barrel lazily after session creation, from an event
 * handler. `BuiltinExtensionAPI` has no `pi`, so the type check rejects the direct form of that.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import { createSessionInFreshProcess } from "../helpers/fresh-session-report";

let scratch: TempDir;
beforeEach(() => {
	scratch = TempDir.createSync("@veyyon-session-barrel-");
});
afterEach(() => {
	scratch.removeSync();
});

it("binds the product's own extensions without evaluating the package barrel", async () => {
	const report = await createSessionInFreshProcess(scratch.join("builtin"), false);

	expect(report.barrelLoaded).toBe(false);
	expect(report.commands).toContain("autoresearch");
	expect(report.authorPi).toBeNull();
}, 40_000);

it("hands an author's inline extension the package namespace as api.pi", async () => {
	const [builtinOnly, withAuthor] = await Promise.all([
		createSessionInFreshProcess(scratch.join("builtin"), false),
		createSessionInFreshProcess(scratch.join("author"), true),
	]);

	expect(withAuthor.barrelLoaded).toBe(true);
	expect(withAuthor.authorPi).toBe("function");
	expect(withAuthor.commands).toEqual(builtinOnly.commands);
}, 40_000);
