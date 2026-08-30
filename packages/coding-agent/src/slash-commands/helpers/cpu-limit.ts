/**
 * Shared logic for `/cpu-limit`, so the text and TUI surfaces accept exactly
 * the same words and report the same sentence.
 *
 * THIS COMMAND DOES NOT CONFIGURE ANYTHING. Every limit is chosen in
 * `/settings` under Resources, at two scopes: `machine.*` bounds every veyyon
 * on the machine and is stored in `~/.veyyon/config.yml`, `session.*` bounds
 * one session tree and is stored per profile. A command that could also set
 * them was a second place to change a value, which is one more than a value
 * can have: the panel showed one number, a command had written another, and
 * neither said so.
 *
 * What is left is the pair of things a panel cannot do. `status` reports what
 * is ACTUALLY happening — the backend the host offers, whether the group
 * exists, whether commands are being refused right now — which no stored
 * setting knows. `lift` is the case the two scopes exist for: a long command
 * is being refused by a budget that made sense for the profile and does not
 * make sense for this piece of work. It overrides to zero for this session
 * only, never writes config, and `reset` puts it back.
 */
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../../config/settings";
import { resolvedMachineBudgetPlacement, sessionCpuLimit } from "../../session/cpu-limit";
import { anyMachineLimitActive, type MachineBudgetLimits, machineBudgetLimits } from "../../session/machine-budget";

/** What a `/cpu-limit` invocation did, and the sentence to show for it. */
export interface CpuLimitCommandResult {
	ok: boolean;
	message: string;
}

/** The words that lift the cap for this session without touching any setting. */
const LIFT_WORDS = new Set(["lift", "remove", "off", "none", "0"]);

/** The words that drop the session override and return to the configured value. */
const RESET_WORDS = new Set(["reset", "default", "inherit"]);

export const CPU_LIMIT_USAGE =
	"Usage: /cpu-limit [status|lift|reset] — set limits in /settings under Resources, at machine and session scope.";

/**
 * Where the effective value comes from, in the operator's words.
 *
 * `runtime` is the only source this command can produce, so it is the one
 * worth naming: it tells a reader that the number on screen is this session's
 * and that `reset` will change it back.
 */
function describeSource(from: Settings): string {
	return from.getSource("session.cpuLimitCores") === "runtime" ? "this session" : "the saved profile setting";
}

/**
 * The machine tier's half of the report, or undefined when no machine limit is
 * set.
 *
 * Reports what the KERNEL took, not what the config says. The two scopes fail
 * independently and the machine one needs a parent that delegates two levels,
 * which a container's cgroup root does not: printing the configured cores on
 * such a host is the same defect at the report that the probe closed at the
 * limiter.
 */
async function describeMachineLimits(sessionCores: number): Promise<string | undefined> {
	let limits: MachineBudgetLimits;
	try {
		limits = machineBudgetLimits();
	} catch (error) {
		// A machine limit that cannot be read is holding nothing, and status is
		// exactly where that has to be visible rather than absent.
		return `Machine limits: unreadable (${errorMessage(error)}), so none is held.`;
	}
	if (!anyMachineLimitActive(limits)) return undefined;
	const parts: string[] = [];
	if (limits.cpuLimitCores > 0) parts.push(`${limits.cpuLimitCores} ${limits.cpuLimitCores === 1 ? "core" : "cores"}`);
	if (limits.memoryLimitGb > 0) parts.push(`${limits.memoryLimitGb} GB memory`);
	if (limits.writeBudgetGb > 0) parts.push(`${limits.writeBudgetGb} GB writes`);
	if (limits.maxProcesses > 0) parts.push(`${limits.maxProcesses} processes`);
	const head = `Machine-wide limit across every veyyon on this machine: ${parts.join(", ")}.`;
	const placement = await resolvedMachineBudgetPlacement();
	if (!placement) return `${head} Not applied yet: nothing in this process has needed the budget group.`;
	if (placement.unenforceable) return `${head} ${placement.unenforceable}`;
	// A session cap above the machine cap is the machine cap: session groups are
	// created inside the machine group. Two numbers on one line with nothing
	// relating them reads as the larger one winning, which is backwards.
	const bounded =
		limits.cpuLimitCores > 0 && sessionCores > limits.cpuLimitCores
			? ` This session's ${sessionCores} core(s) are bounded by it.`
			: "";
	return `${head} The kernel is holding it.${bounded}`;
}

/** The report: both scopes, and what enforcement is actually doing. */
export async function describeCpuLimit(from: Settings, sessionId: string | null | undefined): Promise<string> {
	const cores = from.get("session.cpuLimitCores");
	const kill = from.get("session.cpuLimitKill");
	const scope = describeSource(from);
	const head =
		cores > 0
			? `Session CPU limit: ${cores} ${cores === 1 ? "core" : "cores"}, from ${scope}. Over-budget commands are ${kill ? "killed" : "refused, and running ones keep running"}.`
			: `Session CPU limit: off, from ${scope}.`;
	// The limiter knows things the setting cannot: which backend the host
	// actually offers, whether the group exists yet, and whether the watcher is
	// refusing commands right now. A report built from the setting alone says
	// "2 cores" on a host where nothing can enforce it.
	const live = await sessionCpuLimit(sessionId)?.statusLine();
	const machine = await describeMachineLimits(cores);
	// One fact per line. Three sentences about three different scopes ran together
	// as one paragraph, and the machine-wide limit — the one an operator is least
	// expecting to be holding them — was at the end of it.
	return [head, live ? `Enforcement: ${live}.` : undefined, machine].filter(Boolean).join("\n");
}

/**
 * Apply one `/cpu-limit` invocation against `from`.
 *
 * Every branch that changes anything writes a RUNTIME override, so nothing
 * here can edit a stored setting at either scope by accident.
 */
export async function applyCpuLimitCommand(
	rawArgs: string,
	from: Settings,
	sessionId: string | null | undefined,
): Promise<CpuLimitCommandResult> {
	const arg = rawArgs.trim().toLowerCase();
	if (!arg || arg === "status") {
		return { ok: true, message: await describeCpuLimit(from, sessionId) };
	}
	if (RESET_WORDS.has(arg)) {
		from.clearOverride("session.cpuLimitCores");
		from.clearOverride("session.cpuLimitKill");
		return { ok: true, message: `Session override dropped.\n${await describeCpuLimit(from, sessionId)}` };
	}
	if (LIFT_WORDS.has(arg)) {
		from.override("session.cpuLimitCores", 0);
		// Zero cores: the lift just removed this session's cap, so the machine
		// limit bounds nothing of the session's and the clause must not appear.
		const machine = await describeMachineLimits(0);
		return {
			ok: true,
			message:
				`Session CPU limit lifted for this session. No setting was changed; /cpu-limit reset restores it.` +
				// A machine limit still binds after a session lift, and a person who
				// just lifted a limit and still sees refusals needs to be told which
				// one is refusing rather than left to conclude the lift did nothing.
				(machine ? `\n${machine} That one still applies and is set in /settings under Resources.` : ""),
		};
	}
	return { ok: false, message: CPU_LIMIT_USAGE };
}
