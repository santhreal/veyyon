/**
 * `${VAR}` expansion for discovered configuration, and the report of what it could not resolve.
 *
 * A discovered config is expanded once at load time: `${VAR}` becomes the variable's value and
 * `${VAR:-default}` falls back to the default. The third case is the one this module exists for.
 * An unset variable with no default used to be re-emitted as the literal text `${VAR}`, which made
 * an unresolved reference indistinguishable from config text: every consumer had to rediscover the
 * residue, most did not, and the literal travelled on as a command, a working directory, a URL or a
 * credential id. The MCP connect path refuses it now, but a refusal at the end of the journey does
 * not tell the operator which file names a variable that is not set.
 *
 * So an unresolved reference is a REPORT, not a string. `expandEnvVarsDeep` takes the sink that
 * receives it, and the parameter is required: a caller states what happens to the residue at the
 * call site, and a new consumer cannot inherit silence by writing one fewer argument. Three sinks
 * cover the decisions that exist — turn it into a warning ({@link warnUnresolved}), read it
 * ({@link collectUnresolved}), or drop it because a named guard downstream refuses it
 * ({@link unresolvedRefusedDownstream}).
 *
 * The residue grammar lives here too, beside the code that produces it, so the MCP connect guard
 * and the expansion cannot disagree about what an unresolved reference looks like.
 */

/**
 * The residue an expansion leaves for an unset variable: `${NAME}`, with no `:-default` part, since
 * a default would have been substituted. `[^{}]` keeps a match from spanning two placeholders.
 */
export const UNRESOLVED_ENV_REFERENCE = /\$\{([^{}]+)\}/;

/** A reference the expansion could not resolve. */
export interface UnresolvedEnvReference {
	/**
	 * Where it sits inside the expanded value: `args[2]`, `hosts.build.user`, `""` for a bare
	 * string. Names the field for an operator reading a warning, not a path for code to parse.
	 */
	readonly field: string;
	/** The variable that is not set, exactly as written between `${` and `}`. */
	readonly variable: string;
}

/** Where an expansion reports what it could not resolve. */
export interface UnresolvedEnvSink {
	report(ref: UnresolvedEnvReference): void;
}

/**
 * Reports each unresolved reference as a discovery warning naming `subject` (the file the entry came
 * from), the field and the variable. No value is quoted: an unresolved reference has no value, and
 * the variable's name is the actionable part.
 */
export function warnUnresolved(warnings: string[], subject: string): UnresolvedEnvSink {
	return {
		report(ref) {
			const where = ref.field ? ` in ${ref.field}` : "";
			warnings.push(`${subject}: environment variable ${ref.variable} is not set${where}`);
		},
	};
}

/** Collects the reports for a caller that decides for itself what to do with them. */
export function collectUnresolved(): UnresolvedEnvSink & { readonly refs: UnresolvedEnvReference[] } {
	const refs: UnresolvedEnvReference[] = [];
	return {
		refs,
		report(ref) {
			refs.push(ref);
		},
	};
}

/**
 * Drops the reports because a guard further along refuses the residue and says so to the operator.
 * `reason` names that guard, so a discard is a stated decision rather than a missing argument.
 */
export function unresolvedRefusedDownstream(reason: string): UnresolvedEnvSink {
	if (!reason.trim()) throw new TypeError("unresolvedRefusedDownstream requires the guard that refuses the residue");
	return { report() {} };
}

const REFERENCE = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

function expandString(
	value: string,
	field: string,
	sink: UnresolvedEnvSink,
	extraEnv?: Record<string, string>,
): string {
	return value.replace(REFERENCE, (_, varName: string, defaultValue?: string) => {
		const envValue = extraEnv?.[varName] ?? Bun.env[varName];
		if (envValue !== undefined) return envValue;
		if (defaultValue !== undefined) return defaultValue;
		sink.report({ field, variable: varName });
		return `\${${varName}}`;
	});
}

function expand<T>(obj: T, field: string, sink: UnresolvedEnvSink, extraEnv?: Record<string, string>): T {
	if (typeof obj === "string") return expandString(obj, field, sink, extraEnv) as T;
	if (Array.isArray(obj)) return obj.map((item, index) => expand(item, `${field}[${index}]`, sink, extraEnv)) as T;
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expand(value, field ? `${field}.${key}` : key, sink, extraEnv);
		}
		return result as T;
	}
	return obj;
}

/**
 * Recursively expands environment references, reporting each one it could not resolve to `sink`.
 *
 * The value keeps the literal `${VAR}` for an unresolved reference, because a consumer that
 * currently spawns or dials with it is refused by name downstream rather than handed an empty
 * string that looks like a deliberate setting.
 */
export function expandEnvVarsDeep<T>(obj: T, sink: UnresolvedEnvSink, extraEnv?: Record<string, string>): T {
	return expand(obj, "", sink, extraEnv);
}
