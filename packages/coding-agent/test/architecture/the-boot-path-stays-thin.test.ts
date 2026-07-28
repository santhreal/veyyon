/**
 * The process entry point loads 34 modules, and nothing may quietly make that 1461.
 *
 * `src/cli.ts` is what the `veyyon` binary runs. Everything it imports STATICALLY is parsed and
 * evaluated before the first argument is even looked at, on every invocation, including
 * `veyyon --version` and the worker re-entries that spawn dozens of times in a session. Everything
 * it reaches through `await import(...)` is paid for only by the code path that asks for it.
 *
 * That boundary is the whole design of the file, and it is stated in prose in three places: the
 * NOTE at the top of `tools/index.ts` says the boot path never parses a tool implementation it does
 * not activate, `cli.ts` explains why `.env` loading and worker dispatch happen inside `runCli`
 * rather than at module scope, and the 153 `await import(` sites across the package are the design
 * carried out. Nothing measured it. A single convenience import in `cli.ts`, the kind an editor
 * offers when you type a symbol name, pulls the settings store, the theme, the session and its
 * whole graph onto the boot path, and the only symptom is that startup got slower.
 *
 * WHAT THE NUMBERS ARE. `cli.ts` reaches 34 modules. `main.ts`, one dynamic import away, reaches
 * 1461, and `sdk.ts` reaches 1361. So the lazy boundary is not decorative: it is holding back more
 * than forty times its own weight, and the assertions below say that in both directions, as a
 * ceiling on the entry and as a named list of what must stay off it.
 *
 * WHY A NAMED LIST AND NOT ONLY A CEILING. A ceiling catches the big regression and says nothing
 * about which edge caused it. The named absences point at the fix: if `config/settings.ts` appears
 * on the boot graph, the import to remove is the one that named a setting, whatever the count says.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PACKAGES, reach, reachedNames } from "../helpers/module-reach-gate";

/**
 * What `src/cli.ts` costs before it does anything, measured 2026-07-27 with the workspace resolved
 * to source.
 *
 * This is an upper bound, so the floor below is what makes it mean something: a resolution table
 * that stopped resolving would report a handful of modules and satisfy this while measuring nothing.
 *
 * 35 from 2026-07-27, one more than the 34 measured the same day. The module is `@veyyon/utils/json`,
 * reached through `file-lock.ts`, which used to write `tryParseJson` out by hand as a try/catch around
 * `JSON.parse`. The lock file it reads is JSON, so the parse is real work on this path either way; what
 * changed is that the one owner does it. Raised deliberately, and only by the one module the owner
 * costs: `json.ts` imports `type-guards` and nothing else.
 */
const BOOT_CEILING = 35;

/** The same measurement as a floor, so a broken walk fails instead of passing quietly. */
const BOOT_FLOOR = 25;

/**
 * Modules that must be reached LAZILY or not at all, with what each one costs.
 *
 * Every entry is a module a plausible edit would pull onto the boot path. `main.ts` is the obvious
 * one and the reason `cli.ts` ends with `await import("./main")` rather than a static import.
 * `config/settings.ts` and `modes/theme/theme.ts` are the two most-imported modules in the package,
 * so any helper that touches a setting or a colour drags them along. The tool implementations are
 * the claim `tools/index.ts` makes in prose.
 */
const OFF_THE_BOOT_PATH = [
	"coding-agent/src/main.ts",
	"coding-agent/src/sdk.ts",
	"coding-agent/src/index.ts",
	"coding-agent/src/config/settings.ts",
	"coding-agent/src/config/settings-schema.ts",
	"coding-agent/src/modes/theme/theme.ts",
	"coding-agent/src/session/agent-session.ts",
	"coding-agent/src/session/session-manager.ts",
	"coding-agent/src/tools/index.ts",
	"coding-agent/src/tools/read.ts",
	"coding-agent/src/tools/bash.ts",
	"coding-agent/src/tools/grep.ts",
	"coding-agent/src/edit/index.ts",
] as const;

/**
 * Modules that ARE on the boot path, so a walk that resolved nothing cannot pass the rule above.
 *
 * These four are the entry's real job: parse enough argv to find the profile, dispatch a worker
 * re-entry, and know which subcommand names exist so a typo gets a "did you mean".
 */
const ON_THE_BOOT_PATH = [
	"coding-agent/src/cli/profile-bootstrap.ts",
	"coding-agent/src/cli/flag-tables.ts",
	"coding-agent/src/cli-commands.ts",
	"coding-agent/src/worker-args.ts",
] as const;

/**
 * The one module under `tools/` the boot path may reach.
 *
 * `tools/approval-modes.ts` is the approval-mode value list, and `cli/flag-tables.ts` imports it to
 * validate `--approval`. Its own header says it is kept free of runtime dependencies for exactly
 * this reason, so it reaches nothing and costs one module. Any OTHER `tools/` module appearing here
 * means a tool implementation is being parsed at startup.
 */
const BOOT_TOOL_MODULES = ["coding-agent/src/tools/approval-modes.ts"];

/** A `/`-written path in the shape `reachedNames` produces, so the lists read the same on Windows. */
function asPath(name: string): string {
	return name.split("/").join(path.sep);
}

describe("the boot path stays thin", () => {
	const boot = reachedNames("cli.ts");

	/**
	 * The ceiling. A failure means something on `cli.ts`'s static import graph grew; the list the
	 * next test prints is where to look.
	 */
	it(`cli.ts reaches at most ${BOOT_CEILING} modules with the workspace resolved`, () => {
		expect(reach("cli.ts")).toBeLessThanOrEqual(BOOT_CEILING);
	});

	/**
	 * The floor, which is the half that makes the ceiling honest. Every other assertion in this file
	 * is an upper bound or an absence, and all of them pass against a walk that resolves nothing.
	 */
	it("and really walks the graph rather than resolving nothing", () => {
		expect(reach("cli.ts")).toBeGreaterThanOrEqual(BOOT_FLOOR);

		for (const name of ON_THE_BOOT_PATH) {
			expect(boot, `${name} is part of the entry's own job and must be reachable`).toContain(asPath(name));
		}
	});

	/**
	 * The named absences. Each one is a module whose arrival would be a real regression, and the
	 * message says what it costs so the failure explains itself.
	 */
	it.each(OFF_THE_BOOT_PATH.map(name => [name] as const))("%s is not on the boot path", name => {
		expect(
			boot,
			`${name} is reached statically from cli.ts. Startup now parses it on every invocation, including --version. Take it through await import() at the point of use.`,
		).not.toContain(asPath(name));
	});

	/**
	 * And no tool implementation at all, stated as a shape rather than a list of names, because a
	 * new tool would not be in any list written today.
	 */
	it("parses no tool implementation at startup", () => {
		const toolModules = boot.filter(name => name.startsWith(`coding-agent${path.sep}src${path.sep}tools${path.sep}`));

		expect(toolModules).toEqual(BOOT_TOOL_MODULES.map(asPath));
	});

	/**
	 * The contrast that makes the boundary worth guarding.
	 *
	 * `main.ts` is ONE `await import` away from `cli.ts` and reaches more than a thousand modules.
	 * If that ratio ever collapsed it would mean either that the boot path had grown or that the
	 * lazy boundary had stopped separating anything, and both are worth failing on.
	 */
	it("holds back more than forty times its own weight", () => {
		const bootCost = reach("cli.ts");
		const afterCost = reach("main.ts");

		expect(afterCost).toBeGreaterThan(1000);
		expect(afterCost / bootCost).toBeGreaterThan(40);
	});
});

describe("the reach measurement is the one the other gates use", () => {
	/**
	 * The names this suite compares against are relative to `packages/`, which is the shape the
	 * shared helper produces. A helper that changed that shape would make every `toContain` above
	 * miss silently, and an absence assertion that can never match is the failure mode this whole
	 * file exists to prevent.
	 */
	it("names modules relative to the packages directory", () => {
		const boot = reachedNames("cli.ts");

		expect(boot).toContain(path.join("coding-agent", "src", "cli.ts"));
		expect(PACKAGES.endsWith(`${path.sep}packages`)).toBe(true);
	});
});
