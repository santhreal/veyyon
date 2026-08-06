/**
 * Shared logic for `/cpu-limit`, so the text and TUI surfaces accept exactly
 * the same words and report the same sentence.
 *
 * THE TWO SCOPES. `session.cpuLimitCores` is a per-profile setting: it is
 * chosen once in `/settings` and every session that profile starts inherits
 * it. A single session that needs a different budget says so here, and what
 * this writes is a RUNTIME override: it holds for this session and is never
 * written to config, so switching profiles or restarting returns to the saved
 * value. `reset` drops the override rather than writing the saved number back,
 * which is what keeps a later change to the profile value winning.
 *
 * `remove` is the case the scopes exist for: a long command is being refused
 * or throttled by a budget that made sense for the profile and does not make
 * sense for this piece of work. It lifts the cap for this session alone by
 * overriding to zero, and leaves the profile setting untouched.
 */
import type { Settings } from "../../config/settings";
import { sessionCpuLimit } from "../../session/cpu-limit";

/** What a `/cpu-limit` invocation did, and the sentence to show for it. */
export interface CpuLimitCommandResult {
	ok: boolean;
	message: string;
}

/** The words that lift the cap for this session without touching the profile. */
const REMOVE_WORDS = new Set(["remove", "off", "none", "0"]);

/** The words that drop the session override and return to the profile value. */
const RESET_WORDS = new Set(["reset", "default", "inherit"]);

export const CPU_LIMIT_USAGE = "Usage: /cpu-limit [status|<cores>|remove|reset|kill on|kill off]";

/**
 * Where the effective value comes from, in the operator's words.
 *
 * `getSource` reports the layer, and the two that matter here read very
 * differently to a person: "runtime" is an override this session set and can
 * drop, everything else is the saved value that survives a restart.
 */
function describeSource(from: Settings): string {
	return from.getSource("session.cpuLimitCores") === "runtime" ? "this session" : "the saved profile setting";
}

/** The one-line report: the budget, where it came from, and what it is doing. */
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
	return live ? `${head} Enforcement: ${live}.` : head;
}

/**
 * Apply one `/cpu-limit` invocation against `from`.
 *
 * The write is an override in every branch that changes something, so nothing
 * here can edit the profile's saved budget by accident.
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
	if (REMOVE_WORDS.has(arg)) {
		from.override("session.cpuLimitCores", 0);
		return {
			ok: true,
			message: `CPU limit lifted for this session. The profile setting is unchanged; /cpu-limit reset restores it.`,
		};
	}
	const killMatch = /^kill\s+(on|off|true|false)$/.exec(arg);
	if (killMatch) {
		const on = killMatch[1] === "on" || killMatch[1] === "true";
		from.override("session.cpuLimitKill", on);
		return {
			ok: true,
			message: on
				? "Over-budget commands will be killed for this session, and the kill is reported as a budget action."
				: "Over-budget commands will be refused rather than killed for this session.",
		};
	}
	const cores = Number(arg);
	// `Number("")` is 0 and `Number("2cores")` is NaN; the empty string is
	// already handled above, so this rejects exactly the unparseable words
	// rather than silently reading them as "off".
	if (!Number.isFinite(cores) || cores < 0) return { ok: false, message: CPU_LIMIT_USAGE };
	from.override("session.cpuLimitCores", cores);
	return {
		ok: true,
		message: `${await describeCpuLimit(from, sessionId)} /cpu-limit reset restores the saved default.`,
	};
}
