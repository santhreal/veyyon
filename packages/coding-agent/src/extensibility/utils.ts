export { createNoOpUIContext, resolvePath } from "./utils-helpers";

export class ExtensionExitError extends Error {
	readonly code: number | string | undefined;
	constructor(
		code: number | string | undefined,
		readonly alias = "process.exit",
	) {
		super(
			`Module called ${alias}(${code === undefined ? "" : String(code)}) during guarded extension/hook loading; ` +
				`Veyyon extension/hook modules must not terminate the host process.`,
		);
		this.name = "ExtensionExitError";
		this.code = code;
	}
}

type ExitAliasName = "process.exit" | "process.reallyExit";

let exitGuardDepth = 0;
let exitGuardOriginalProcessExit: typeof process.exit | null = null;
let exitGuardOriginalReallyExit: typeof process.reallyExit | null = null;

/** Run `fn` with hard-exit APIs patched so any synchronous attempt to terminate the host raises {@link ExtensionExitError} instead. Restored in `finally`. */
function guardedExit(alias: ExitAliasName): (code?: number | string) => never {
	return (code?: number | string): never => {
		throw new ExtensionExitError(code, alias);
	};
}

export async function withExitGuard<T>(fn: () => Promise<T>): Promise<T> {
	if (exitGuardDepth === 0) {
		exitGuardOriginalProcessExit = process.exit;
		process.exit = guardedExit("process.exit") as typeof process.exit;

		if (typeof process.reallyExit === "function") {
			exitGuardOriginalReallyExit = process.reallyExit;
			process.reallyExit = guardedExit("process.reallyExit") as typeof process.reallyExit;
		}
	}
	exitGuardDepth++;
	try {
		return await fn();
	} finally {
		exitGuardDepth--;
		if (exitGuardDepth === 0) {
			if (exitGuardOriginalProcessExit) {
				process.exit = exitGuardOriginalProcessExit;
				exitGuardOriginalProcessExit = null;
			}
			if (exitGuardOriginalReallyExit) {
				process.reallyExit = exitGuardOriginalReallyExit;
				exitGuardOriginalReallyExit = null;
			}
		}
	}
}
