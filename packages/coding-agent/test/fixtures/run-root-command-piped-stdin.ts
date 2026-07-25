/**
 * Drives `runRootCommand` once in a child process, and reports how far it got.
 *
 * Lives in a child rather than in the test because the hazard is the PROCESS's
 * stdin: an in-process test cannot hand itself an open pipe with no writer,
 * which is exactly the condition that parks the default piped-prompt reader
 * forever. The parent spawns this with `stdin: "pipe"` and never writes.
 *
 * `INJECT=1` supplies the `readPipedInput` dependency; anything else leaves the
 * default in place. Either way the run is stopped at `createAgentSession` with a
 * sentinel error, and the reached point is printed as `REACHED:<message>` so the
 * parent asserts on an exact string rather than on "it produced some output".
 *
 * `HOME` and `FIXTURE_DIR` are set by the parent to the same temp directory, so
 * nothing here touches the developer's real config root.
 */
const { runRootCommand } = await import("@veyyon/coding-agent/main");
const { parseArgs } = await import("@veyyon/coding-agent/cli/args");
const { Settings } = await import("@veyyon/coding-agent/config/settings");
const { AuthStorage } = await import("@veyyon/coding-agent/session/auth-storage");

const dir = process.env.FIXTURE_DIR as string;
const authStorage = await AuthStorage.create(`${dir}/auth.db`);

const rawArgs = ["--print", "hello"];
const parsed = parseArgs(rawArgs);
parsed.noExtensions = true;
parsed.noSkills = true;
parsed.noRules = true;
parsed.noTools = true;
parsed.noLsp = true;
parsed.sessionDir = dir;

const deps: Record<string, unknown> = {
	discoverAuthStorage: async () => authStorage,
	settings: Settings.isolated({}),
	createAgentSession: async () => {
		throw new Error("SENTINEL");
	},
};
if (process.env.INJECT === "1") {
	deps.readPipedInput = async () => undefined;
}

try {
	await runRootCommand(parsed, rawArgs, deps as never);
	console.log("REACHED:no-throw");
} catch (error) {
	console.log(`REACHED:${(error as Error).message}`);
}
process.exit(0);
