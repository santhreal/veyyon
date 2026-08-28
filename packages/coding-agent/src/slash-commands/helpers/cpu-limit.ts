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
import type { Settings } from "../../config/settings";
import { sessionCpuLimit } from "../../session/cpu-limit";
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

/** The machine tier's half of the report, or undefined when no machine limit is set. */
function describeMachineLimits(): string | undefined {
	let limits: MachineBudgetLimits;
	try {
		limits = machineBudgetLimits();
	} catch (error) {
		// A machine limit that cannot be read is holding nothing, and status is
		// exactly where that has to be visible rather than absent.
		return `Machine limits: unreadable (${error instanceof Error ? error.message : String(error)}), so none is held.`;
	}
	if (!anyMachineLimitActive(limits)) return undefined;
	const parts: string[] = [];
	if (limits.cpuLimitCores > 0) parts.push(`${limits.cpuLimitCores} core(s)`);
	if (limits.memoryLimitGb > 0) parts.push(`${limits.memoryLimitGb} GB memory`);
	if (limits.writeBudgetGb > 0) parts.push(`${limits.writeBudgetGb} GB writes`);
	if (limits.maxProcesses > 0) parts.push(`${limits.maxProcesses} processes`);
	return `Machine-wide limit across every veyyon on this machine: ${parts.join(", ")}.`;
}

/** The report: both scopes, and what enforcement is actually doing. */
export async function describeCpuLimit(from: Settings, sessionId: string | null | undefined): Promise<string> {
	const cores = from.get("session.cpuLimitCores");
	const kill = from.get("session.cpuLimitKill");
	const scope = describeSource(from);
	const head =
		cores > 0
			? `Session CPU limit: ${cores} core(s), from ${scope}. Over-budget commands are ${kill ? "killed" : "refused, and running ones keep running"}.`
			: `Session CPU limit: off, from ${scope}.`;
	// The limiter knows things the setting cannot: which backend the host
	// actually offers, whether the group exists yet, and whether the watcher is
	// refusing commands right now. A report built from the setting alone says
	// "2 cores" on a host where nothing can enforce it.
	const live = await sessionCpuLimit(sessionId)?.statusLine();
	const machine = describeMachineLimits();
	return [head, live ? `Enforcement: ${live}.` : undefined, machine].filter(Boolean).join(" ");
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
		return { ok: true, message: `Session override dropped. ${await describeCpuLimit(from, sessionId)}` };
	}
	if (LIFT_WORDS.has(arg)) {
		from.override("session.cpuLimitCores", 0);
		const machine = describeMachineLimits();
		return {
			ok: true,
			message:
				`Session CPU limit lifted for this session. No setting was changed; /cpu-limit reset restores it.` +
				// A machine limit still binds after a session lift, and a person who
				// just lifted a limit and still sees refusals needs to be told which
				// one is refusing rather than left to conclude the lift did nothing.
				(machine ? ` ${machine} That one still applies and is set in /settings under Resources.` : ""),
		};
	}
	return { ok: false, message: CPU_LIMIT_USAGE };
}
