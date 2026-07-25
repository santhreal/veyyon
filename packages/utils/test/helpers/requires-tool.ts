/**
 * Gate a suite on an external tool, without letting the gate hide a failure.
 *
 * ## The problem this exists for
 *
 * `describe.skipIf(!HAS_JULIA)` reads like a courtesy to developers who do not
 * have julia installed. What it actually produces is a suite that runs ONLY
 * where nobody looks at it. Julia is absent on every dev machine on this fleet,
 * so a local run reports `2 skip / 0 fail` and looks clean, and the suite is
 * left to whichever environment happens to have the tool. Nothing anywhere says
 * the coverage is gone.
 *
 * That is the same shape as a silent fallback: the weaker path is taken, the
 * result is worse, and nothing says so. A skip is a hole in coverage, and a hole
 * in coverage has to be visible at the moment it opens.
 *
 * ## What this does instead
 *
 * - Tool present: the suite runs, exactly as before.
 * - Tool missing on a developer machine: the suite is skipped AND a line is
 *   printed naming the tool, the suite, and how to install it. You cannot run
 *   the file and come away believing it passed.
 * - Tool missing where the environment DECLARED it (`VEYYON_REQUIRE_TOOLS`): the
 *   suite FAILS. A runner that is provisioned with julia and loses it is a
 *   configuration bug, and silently skipping is how a provisioning regression
 *   turns an entire suite off for months without one red build. Fail closed, the
 *   same rule the rest of this codebase follows.
 *
 * ```ts
 * describeRequiringTool("julia", "eval Julia prelude helpers", () => {
 *   it("evaluates a range", async () => { ... });
 * });
 * ```
 */
import { describe } from "bun:test";
import { $which } from "@veyyon/utils";

/**
 * Tools this environment DECLARES it provides, from `VEYYON_REQUIRE_TOOLS`
 * (comma-separated).
 *
 * Deliberately not "am I on CI". A runner that was never provisioned with julia
 * is not lying when julia is absent, and failing there would just make every
 * build red for a tool nobody promised. The declaration is what creates the
 * obligation: a workflow that installs julia adds `julia` to this variable, and
 * from then on julia going missing is a provisioning regression that fails
 * loudly instead of quietly switching the suite off.
 */
const DECLARED_TOOLS = new Set(
	(process.env.VEYYON_REQUIRE_TOOLS ?? "")
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean),
);

/** Where to point someone whose machine is missing the tool. */
const INSTALL_HINTS: Record<string, string> = {
	julia: "https://julialang.org/install/ (or `juliaup add release`)",
	python3: "your platform's python package, or https://www.python.org/downloads/",
	rg: "https://github.com/BurntSushi/ripgrep#installation",
};

/** What a gate decided to do, and the exact text it will emit. */
export interface ToolGateDecision {
	/** `run` executes the suite, `skip` reports it loudly, `fail` errors the suite. */
	action: "run" | "skip" | "fail";
	/** The warning or error text. Empty when the suite runs. */
	message: string;
}

/**
 * The gate's decision, separated from `describe` so it can be tested directly.
 *
 * A test cannot easily observe whether a nested `describe` was registered,
 * skipped, or thrown from, and a helper whose whole purpose is "a skip must not
 * be silent" is worth more than shape assertions. So the decision is a pure
 * function of (tool present, tool declared) and is asserted on its exact text.
 */
export function resolveToolGate(options: {
	tool: string;
	name: string;
	present: boolean;
	/** Whether the environment declared it provides this tool (`VEYYON_REQUIRE_TOOLS`). */
	declared: boolean;
}): ToolGateDecision {
	const { tool, name, present, declared } = options;
	if (present) return { action: "run", message: "" };
	if (declared) {
		return {
			action: "fail",
			message:
				`${tool} is not on PATH, but this environment declares it via VEYYON_REQUIRE_TOOLS, so "${name}" ` +
				`cannot run and must not be skipped. Install ${tool} where this suite runs, or stop declaring it.`,
		};
	}
	const hint = INSTALL_HINTS[tool];
	return {
		action: "skip",
		message:
			`[skip] "${name}" needs ${tool}, which is not on PATH, so it did NOT run here. ` +
			`An environment that declares ${tool} does run it, so a failure you cannot see locally is possible.` +
			(hint ? ` Install: ${hint}` : ""),
	};
}

/**
 * `describe` for a suite that cannot run without `tool` on PATH.
 *
 * Prefer this over `describe.skipIf(!$which(tool))` everywhere. The skip
 * behaviour is the same on a developer machine; the difference is that the skip
 * announces itself, and that an environment which declared the tool cannot skip
 * at all.
 */
export function describeRequiringTool(tool: string, name: string, body: () => void): void {
	const decision = resolveToolGate({
		tool,
		name,
		present: Boolean($which(tool)),
		declared: DECLARED_TOOLS.has(tool),
	});
	if (decision.action === "run") {
		describe(name, body);
		return;
	}
	if (decision.action === "fail") {
		// Not `describe.skip`: a suite that silently disappears on the only machine
		// that runs it is the failure mode this helper exists to prevent.
		describe(name, () => {
			throw new Error(decision.message);
		});
		return;
	}
	console.warn(decision.message);
	describe.skip(name, body);
}
