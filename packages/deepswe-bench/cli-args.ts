export const VALUELESS_FLAGS = { "dry-run": true } as const satisfies Record<string, true>;

export function parseArgs(argv: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) continue;

		const eq = arg.indexOf("=");
		if (eq !== -1) {
			out[arg.slice(2, eq)] = arg.slice(eq + 1);
			continue;
		}

		const name = arg.slice(2);
		if (Object.hasOwn(VALUELESS_FLAGS, name)) {
			out[name] = "";
			continue;
		}
		out[name] = argv[++i] ?? "";
	}
	return out;
}
