/**
 * A session whose tools and extensions are all the product's own never evaluates Zod.
 *
 * WHY THIS SUITE EXISTS. No first-party tool, command or extension validates with Zod, yet every
 * session evaluated its 80 modules: the search tool declared its parameters as a Zod object, the
 * command, custom-tool and extension loaders imported Zod at the top level to hand it to an author
 * API even when no author code was loaded, and the wire-schema converter imported Zod's classic
 * namespace to reach `toJSONSchema`. An idle interactive session held 1.8 MiB more heap and extra
 * memory and 17,800 more live objects for it.
 *
 * THE CLASS THIS CLOSES. Not "these four files imported Zod" but "a first-party route evaluates Zod
 * before an author's code asks for it". The check reads the module registry of a fresh process at
 * the choke points: once `createAgentSession` resolves, once every active tool is converted to the
 * wire schema a request sends, and once every built-in and hidden tool factory, called with every
 * tool-enabling setting on, has its tool converted too. A new factory joins that sweep from the
 * registry without an edit here, a factory the sweep cannot construct fails the suite, and any
 * import of Zod from a tool, loader, converter or helper they reach turns it red whichever file
 * holds it.
 *
 * The author arm is the positive control. It proves the probe sees Zod when Zod is evaluated, and it
 * pins the contract the change keeps: an author's inline extension still receives Zod as `api.zod`.
 *
 * WHAT IT DOES NOT CATCH. Zod reached after session creation from an event handler, a tool's
 * `execute`, a provider stream or model discovery, none of which session creation runs. The
 * GitLab Duo workflow discovery parser is one such path; its parsing is covered by
 * `packages/catalog/test/gitlab-duo-workflow-discovery.test.ts`.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import { createSessionInFreshProcess } from "../helpers/fresh-session-report";

let scratch: TempDir;
beforeEach(() => {
	scratch = TempDir.createSync("@veyyon-session-zod-");
});
afterEach(() => {
	scratch.removeSync();
});

it("creates a session, converts every first-party tool's schema, and evaluates no Zod module", async () => {
	const report = await createSessionInFreshProcess(scratch.join("builtin"), false);

	expect(report.zodAtCreate).toEqual([]);
	expect(report.zodAtWire).toEqual([]);
	expect(report.zodAtEveryTool).toEqual([]);
	expect(report.unbuiltFactories).toEqual([]);
	expect(report.tools).toContain("search");
	expect(report.authorZod).toBeNull();
}, 40_000);

it("evaluates Zod for an author's inline extension and hands it over as api.zod", async () => {
	const report = await createSessionInFreshProcess(scratch.join("author"), true);

	expect(report.zodAtCreate.length).toBeGreaterThan(0);
	expect(report.authorZod).toBe("function");
}, 40_000);
