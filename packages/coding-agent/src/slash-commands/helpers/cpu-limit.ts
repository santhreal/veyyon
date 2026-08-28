import type { Settings } from "../../config/settings";
import { sessionCpuLimit } from "../../session/cpu-limit";

export interface CpuLimitCommandResult {
	ok: boolean;
	message: string;
}

const REMOVE_WORDS = new Set(["remove", "off", "none", "0"]);

const RESET_WORDS = new Set(["reset", "default", "inherit"]);

export const CPU_LIMIT_USAGE = "Usage: /cpu-limit [status|<cores>|remove|reset|kill on|kill off]";

function describeSource(from: Settings): string {
	return from.getSource("session.cpuLimitCores") === "runtime" ? "this session" : "the saved profile setting";
}

export async function describeCpuLimit(from: Settings, sessionId: string | null | undefined): Promise<string> {
	const cores = from.get("session.cpuLimitCores");
	const kill = from.get("session.cpuLimitKill");
	const scope = describeSource(from);
	const head =
		cores > 0
			? `Session CPU limit: ${cores} core(s), from ${scope}. Over-budget commands are ${kill ? "killed" : "refused, and running ones keep running"}.`
			: `Session CPU limit: off, from ${scope}.`;
	const live = await sessionCpuLimit(sessionId)?.statusLine();
	return live ? `${head} Enforcement: ${live}.` : head;
}

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
	if (!Number.isFinite(cores) || cores < 0) return { ok: false, message: CPU_LIMIT_USAGE };
	from.override("session.cpuLimitCores", cores);
	return {
		ok: true,
		message: `${await describeCpuLimit(from, sessionId)} /cpu-limit reset restores the saved default.`,
	};
}
