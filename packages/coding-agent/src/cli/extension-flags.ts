import { type Args, parseArgs } from "./args";

/** Minimal extension-runner surface needed to resolve CLI flag values. The real `ExtensionRunner` satisfies this structurally; depending only on the surface */
export interface ExtensionFlagSink {
	getFlags(): Map<string, { type: "boolean" | "string" }>;
	setFlagValue(name: string, value: boolean | string): void;
}

/** Resolve extension-registered CLI flags from `rawArgs` once the flag set is known, push the resolved values onto the sink, and return the parsed */
export function applyExtensionFlags(runner: ExtensionFlagSink | undefined, rawArgs: string[]): Args | null {
	const extensionFlags = runner?.getFlags();
	if (!runner || !extensionFlags || extensionFlags.size === 0) {
		return null;
	}
	const parsed = parseArgs(rawArgs, extensionFlags);
	// `parseArgs` only records registered extension flags in `unknownFlags`, so
	// every entry here is a flag this runner owns that was actually passed.
	for (const [name, value] of parsed.unknownFlags) {
		runner.setFlagValue(name, value);
	}
	return parsed;
}
