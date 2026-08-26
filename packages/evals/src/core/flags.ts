/**
 * The one definition of the command-line flag grammar every evals entry point reads.
 *
 * Four scripts each carried their own `parseArgs`, and the four disagreed on the two
 * cases that matter. `--dry-run tasks/smoke.txt` swallowed the path in three of them
 * unless the flag happened to be registered as valueless, and a flag at the end of the
 * argument list produced `""` in one, `"true"` in another and `true` in a third, so the
 * same invocation meant different things depending on which script read it.
 *
 * The grammar, stated once:
 *
 * - `--key=value` sets `key` to `value`, whatever the grammar says about `key`.
 * - a key declared valueless takes no value and sets `""`, so the next argument stays
 *   available as a positional or as another flag's value.
 * - `--key value` sets `key` to `value` when `value` does not itself open with `--`.
 * - `--key` at the end of the list, or followed by another flag, sets `"true"`.
 * - a repeated flag keeps the last value, because a wrapper script appends overrides.
 * - an alias maps one spelling onto another key before any of the above applies.
 *
 * Values are strings so a caller reads a flag the same way whether it arrived as
 * `--jobs=8` or `--jobs 8`; `flagNumber` is the one place a numeric flag is rejected.
 *
 * A grammar declares every key it accepts, so a misspelled flag refuses the invocation
 * instead of running with the default the caller was trying to change, and a stray argument
 * that names no flag refuses rather than being read by nothing.
 */

/** A flag the grammar does not declare, or a stray argument that names no flag. */
export class UnknownFlagError extends Error {
	constructor(what: string, accepted: readonly string[]) {
		super(`${what}. Accepted flags: ${accepted.map(key => `--${key}`).join(", ")}`);
		this.name = "UnknownFlagError";
	}
}

/**
 * A declared flag whose value the invocation cannot use: a count that is not one, a spelling
 * outside the accepted set, a required flag left off. It is the same class of mistake as an
 * unknown flag — the command line is wrong, nothing ran — so an entry point maps both to the
 * usage exit code instead of the one a failed run returns.
 */
export class FlagValueError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FlagValueError";
	}
}

export interface FlagGrammar {
	/** Keys that take a value: `{ model: true }`. */
	valued: Readonly<Record<string, true>>;
	/** Keys that take no value: `{ "dry-run": true }`. */
	valueless?: Readonly<Record<string, true>>;
	/** Alternate spellings mapped onto a key, including short forms: `{ h: "help" }`. */
	aliases?: Readonly<Record<string, string>>;
	/** Keys accepted beyond `valued`, contributed by a plugin the entry point resolves. */
	extraValued?: readonly string[];
}

/** Parse `argv` (already stripped of the runtime and script path) into flag values. */
export function parseFlags(argv: string[], grammar: FlagGrammar): Record<string, string> {
	const { valued, valueless = {}, aliases = {}, extraValued = [] } = grammar;
	const canonical = (name: string): string => (Object.hasOwn(aliases, name) ? aliases[name] : name);
	const accepted = [...new Set([...Object.keys(valued), ...extraValued, ...Object.keys(valueless)])].sort();
	const known = new Set(accepted);
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const dashed = arg.startsWith("--") ? arg.slice(2) : arg.startsWith("-") ? arg.slice(1) : null;
		if (dashed === null) {
			throw new UnknownFlagError(`Unexpected argument "${arg}": every input is named by a flag`, accepted);
		}
		if (dashed === "") continue;
		const eq = dashed.indexOf("=");
		if (eq !== -1) {
			const key = canonical(dashed.slice(0, eq));
			if (!known.has(key)) throw new UnknownFlagError(`Unknown flag "--${key}"`, accepted);
			out[key] = dashed.slice(eq + 1);
			continue;
		}
		const key = canonical(dashed);
		if (!known.has(key)) throw new UnknownFlagError(`Unknown flag "--${key}"`, accepted);
		if (Object.hasOwn(valueless, key)) {
			out[key] = "";
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			out[key] = next;
			i++;
		} else {
			out[key] = "true";
		}
	}
	return out;
}

/** Read a numeric flag, or reject the invocation by name. Absent stays absent. */
export function flagNumber(flags: Record<string, string>, key: string): number | undefined {
	const raw = flags[key];
	if (raw === undefined || raw === "" || raw === "true") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new FlagValueError(`--${key} expects a number, got ${JSON.stringify(raw)}`);
	return value;
}

/** Read a flag that counts something: an integer >= 1, or a refusal by name. */
export function flagCount(flags: Record<string, string>, key: string): number | undefined {
	const value = flagNumber(flags, key);
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1) {
		throw new FlagValueError(`--${key} expects an integer >= 1, got ${JSON.stringify(flags[key])}`);
	}
	return value;
}

/** Read a flag pinned to a set of spellings, or a refusal naming the ones it accepts. */
export function flagChoice<T extends string>(
	flags: Record<string, string>,
	key: string,
	choices: readonly T[],
): T | undefined {
	const raw = flags[key];
	if (raw === undefined || raw === "" || raw === "true") return undefined;
	if (!(choices as readonly string[]).includes(raw)) {
		throw new FlagValueError(`--${key} expects one of ${choices.join(", ")}, got ${JSON.stringify(raw)}`);
	}
	return raw as T;
}

/** Read a flag that the invocation cannot proceed without. */
export function requireFlag(flags: Record<string, string>, key: string, usage: string): string {
	const value = flags[key];
	if (value === undefined || value === "" || value === "true")
		throw new FlagValueError(`--${key} is required (${usage})`);
	return value;
}
