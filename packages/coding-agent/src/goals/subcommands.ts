/**
 * What `/goal` accepts after its name.
 *
 * Both hosts parse the same words: the terminal from its command row, the
 * window from the palette draft the desktop sends. The table and the parse
 * are here rather than in either host, so a word added to one is offered by
 * both.
 */

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop";

/**
 * Every word `/goal` accepts after its name. Keyed by the union so the two stay in step, and
 * exported so a sweep over the command surface reads the list rather than restating it.
 */
export const GOAL_SUBCOMMANDS: Record<GoalSubcommand, true> = {
	set: true,
	show: true,
	pause: true,
	resume: true,
	drop: true,
};

/**
 * The first word and what follows it, when that word is one `/goal` accepts.
 *
 * A draft that opens with anything else is an objective, not a subcommand, so it comes back whole
 * in `rest`: `/goal ship the parity work` sets that objective rather than failing on `ship`.
 */
export function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (first in GOAL_SUBCOMMANDS) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}
