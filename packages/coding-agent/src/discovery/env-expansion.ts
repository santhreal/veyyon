/** `${VAR}` expansion for discovered configuration, and the report of what it could not resolve. A discovered config is expanded once at load time: `${VAR}` becomes the variable's value and */

/** The residue an expansion leaves for an unset variable: `${NAME}`, with no `:-default` part, since a default would have been substituted. `[^{}]` keeps a match from spanning two placeholders. */
export const UNRESOLVED_ENV_REFERENCE = /\$\{([^{}]+)\}/;

/** A reference the expansion could not resolve. */
export interface UnresolvedEnvReference {
	/** Where it sits inside the expanded value: `args[2]`, `hosts.build.user`, `""` for a bare string. Names the field for an operator reading a warning, not a path for code to parse. */
	readonly field: string;
	/** The variable that is not set, exactly as written between `${` and `}`. */
	readonly variable: string;
}

/** Where an expansion reports what it could not resolve. */
export interface UnresolvedEnvSink {
	report(ref: UnresolvedEnvReference): void;
}

/** Reports each unresolved reference as a discovery warning naming `subject` (the file the entry came from), the field and the variable. No value is quoted: an unresolved reference has no value, and */
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

/** Drops the reports because a guard further along refuses the residue and says so to the operator. `reason` names that guard, so a discard is a stated decision rather than a missing argument. */
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

/** Recursively expands environment references, reporting each one it could not resolve to `sink`. The value keeps the literal `${VAR}` for an unresolved reference, because a consumer that */
export function expandEnvVarsDeep<T>(obj: T, sink: UnresolvedEnvSink, extraEnv?: Record<string, string>): T {
	return expand(obj, "", sink, extraEnv);
}
