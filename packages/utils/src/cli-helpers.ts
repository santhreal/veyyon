export const NEGATIVE_NUMBER = /^-(?:\d|\.\d)/;
export const NEGATIVE_MASK = "\u0000neg\u0000";

export interface ParsedArgs {
	values: Record<string, string | boolean | Array<string | boolean> | undefined>;
	positionals: string[];
}

export function maskNegativeNumbers(argv: readonly string[]): {
	args: string[];
	restore: (parsed: ParsedArgs) => ParsedArgs;
} {
	const masked: string[] = [];
	const originals: string[] = [];
	let afterDoubleDash = false;
	for (const token of argv) {
		if (afterDoubleDash || !NEGATIVE_NUMBER.test(token)) {
			masked.push(token);
			if (token === "--") afterDoubleDash = true;
			continue;
		}
		masked.push(`${NEGATIVE_MASK}${originals.length}`);
		originals.push(token);
	}

	if (originals.length === 0) return { args: masked, restore: parsed => parsed };

	const unmask = (value: string): string => {
		if (!value.startsWith(NEGATIVE_MASK)) return value;
		const index = Number(value.slice(NEGATIVE_MASK.length));
		return originals[index] ?? value;
	};

	return {
		args: masked,
		restore: parsed => {
			const values: ParsedArgs["values"] = {};
			for (const [name, value] of Object.entries(parsed.values)) {
				if (typeof value === "string") values[name] = unmask(value);
				else if (Array.isArray(value))
					values[name] = value.map(item => (typeof item === "string" ? unmask(item) : item));
				else values[name] = value;
			}
			return { values, positionals: parsed.positionals.map(unmask) };
		},
	};
}

export const CLI_EXIT_USAGE = 2;
