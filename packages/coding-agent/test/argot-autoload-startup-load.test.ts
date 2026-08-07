/**
 * `argot.autoload`: who loads the launch project, the session or the agent.
 *
 * Why this suite exists:
 *   A dictionary has to be built before any handle exists, and until this setting
 *   was added there was exactly one way that happened at startup -- the SDK armed
 *   the launch folder unconditionally, with the condition spelled out inline at the
 *   call site. Two things were wrong with that. The shipped documentation said the
 *   opposite ("veyyon does not guess which project you mean: the agent decides"),
 *   so an operator reading the handbook could not predict whether their repository
 *   would be walked at startup; and there was no way to say no, which matters on a
 *   very large tree where the first walk is the expensive part of the feature.
 *
 * The contract these tests lock in:
 *   - The decision has ONE owner, `shouldAutoloadArgotAtStartup`, and each of its
 *     three conditions is a genuinely different reason not to walk a repository.
 *   - The setting decides WHEN a dictionary is built and NOTHING ELSE. Turning it
 *     off must not touch expansion, must not withhold the codec, and must not
 *     disarm a session that a resume already re-armed.
 *   - The SDK's only startup arm routes through the owner, so the setting cannot be
 *     honoured on one path and ignored on another.
 *
 * The decode case at the end is the Law-10 one. A knob that quietly stopped
 * handles expanding would be a recall loss dressed up as a preference, and it
 * would be invisible: the model writes `§conn`, the tool receives `§conn`, and
 * nothing in the transcript says a dictionary was missing. So the proof here is an
 * exact-bytes expansion on a session that skipped the startup load.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createArgotSession, shouldAutoloadArgotAtStartup } from "@veyyon/coding-agent/argot-cache";
import { ArgotSession } from "argot";

const CONNECTION = "packages/coding-agent/src/database/connection.ts";

/** A session in the state a resume leaves behind: one project already re-armed. */
function loadedSession(): ArgotSession {
	const session = new ArgotSession();
	session.load("/repo", {
		version: 1,
		sigil: "§",
		handles: new Map([["conn", CONNECTION]]),
		meta: new Map(),
	});
	return session;
}

describe("shouldAutoloadArgotAtStartup: the startup load happens only with all three conditions", () => {
	/**
	 * The shipped default. Argot on, autoload on, a session that has not loaded
	 * anything: this is the out-of-the-box adoption path, and it is the reason the
	 * feature works without the model spending its first turn on `argot_load`.
	 */
	it("arms a fresh session when the feature is on and autoload is on", () => {
		expect(shouldAutoloadArgotAtStartup({ enabled: true, autoload: true, argot: new ArgotSession() })).toBe(true);
	});

	/**
	 * The setting doing its one job. Nothing else about the session changes -- the
	 * feature is still on and the codec is still unarmed -- so this case is what
	 * distinguishes "loading was disabled" from the other two refusals.
	 */
	it("refuses when autoload is off, with everything else unchanged", () => {
		const argot = new ArgotSession();
		expect(shouldAutoloadArgotAtStartup({ enabled: true, autoload: true, argot })).toBe(true);
		expect(shouldAutoloadArgotAtStartup({ enabled: true, autoload: false, argot })).toBe(false);
	});

	/**
	 * The master switch still outranks it. An operator who left autoload at its
	 * default of `true` and turned the feature off must not get a repository walk;
	 * if this ever returned true, every default install would walk its tree.
	 */
	it("refuses when the feature is off, even with autoload left on", () => {
		expect(shouldAutoloadArgotAtStartup({ enabled: false, autoload: true, argot: new ArgotSession() })).toBe(false);
	});

	/**
	 * `createArgotSession` returns `undefined` for a subagent set to `off`, so this
	 * is a real state a running session reaches with the feature enabled. There is
	 * no codec to load a dictionary into, and asking for one would be a crash.
	 */
	it("refuses when there is no codec to arm", () => {
		expect(shouldAutoloadArgotAtStartup({ enabled: true, autoload: true, argot: undefined })).toBe(false);
	});

	/**
	 * A resumed session re-arms the roots its branch recorded before this decision
	 * is made, so `loaded` is already true. Loading again would rebuild a dictionary
	 * the session is holding, walking the tree for a result it already has.
	 */
	it("refuses when the session is already loaded, as a resume leaves it", () => {
		const resumed = loadedSession();
		expect(resumed.loaded).toBe(true);
		expect(shouldAutoloadArgotAtStartup({ enabled: true, autoload: true, argot: resumed })).toBe(false);
	});

	/**
	 * The exhaustive table, so a future refactor that reorders or short-circuits the
	 * conditions cannot pass by getting one row right. Only the all-true row arms.
	 */
	it("arms on exactly one of the eight enabled/autoload/loaded combinations", () => {
		const rows: { enabled: boolean; autoload: boolean; loaded: boolean; armed: boolean }[] = [
			{ enabled: true, autoload: true, loaded: false, armed: true },
			{ enabled: true, autoload: true, loaded: true, armed: false },
			{ enabled: true, autoload: false, loaded: false, armed: false },
			{ enabled: true, autoload: false, loaded: true, armed: false },
			{ enabled: false, autoload: true, loaded: false, armed: false },
			{ enabled: false, autoload: true, loaded: true, armed: false },
			{ enabled: false, autoload: false, loaded: false, armed: false },
			{ enabled: false, autoload: false, loaded: true, armed: false },
		];
		for (const row of rows) {
			const argot = row.loaded ? loadedSession() : new ArgotSession();
			expect(shouldAutoloadArgotAtStartup({ enabled: row.enabled, autoload: row.autoload, argot })).toBe(row.armed);
		}
	});
});

describe("argot.autoload changes when a dictionary is built, and nothing else", () => {
	/**
	 * The Law-10 case. Expansion is unconditional once any dictionary loads, so a
	 * session that skipped the startup load and then loaded a project through the
	 * agent's own `argot_load` must expand to the exact bytes. A silent recall loss
	 * here would look identical to a model that simply never wrote a handle.
	 */
	it("a session that skipped the startup load still expands to exact bytes once loaded", () => {
		const argot = new ArgotSession();
		expect(shouldAutoloadArgotAtStartup({ enabled: true, autoload: false, argot })).toBe(false);
		expect(argot.expand("§conn")).toBe("§conn");

		argot.load("/repo", {
			version: 1,
			sigil: "§",
			handles: new Map([["conn", CONNECTION]]),
			meta: new Map(),
		});

		expect(argot.expand("§conn")).toBe(CONNECTION);
		expect(argot.expand(`read §conn now`)).toBe(`read ${CONNECTION} now`);
	});

	/**
	 * Turning the startup load off must not withhold the codec: the model still gets
	 * `argot_load`, and a handle it writes after loading still expands. If autoload
	 * off had been implemented by declining to build the session, the setting would
	 * silently mean "off" and the second knob would be redundant.
	 */
	it("leaves the codec built, so the agent can still load a project itself", () => {
		const session = createArgotSession({ enabled: true, isSubagent: false, subagentMode: "off" });
		expect(session).toBeDefined();
		expect(session?.loaded).toBe(false);
		expect(shouldAutoloadArgotAtStartup({ enabled: true, autoload: false, argot: session })).toBe(false);
	});
});

describe("the SDK honours the setting on its only startup path", () => {
	/**
	 * A settings knob is only real if every path reads it. The SDK arms exactly once
	 * at session construction, and this pins that the arm is guarded by the shared
	 * owner rather than by a second inline copy of the conditions -- the way the
	 * condition was written before this setting existed, and the way it would drift
	 * back the first time somebody adds another startup path.
	 */
	it("guards armArgotAfterStartup with shouldAutoloadArgotAtStartup and reads the setting", () => {
		const sdk = fs.readFileSync(path.join(import.meta.dir, "../src/sdk.ts"), "utf8");
		const arms = [...sdk.matchAll(/armArgotAfterStartup\(/g)];
		expect(arms.length).toBe(1);

		const guardIndex = sdk.indexOf("shouldAutoloadArgotAtStartup({");
		expect(guardIndex).toBeGreaterThan(-1);
		expect(guardIndex).toBeLessThan(arms[0]!.index!);

		const guard = sdk.slice(guardIndex, arms[0]!.index!);
		expect(guard).toContain(`settings.get("argot.autoload")`);
	});
});
