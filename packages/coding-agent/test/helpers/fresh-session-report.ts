import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { hermeticSpawnEnv } from "./hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "session-package-barrel.ts");

/** What `fixtures/session-package-barrel.ts` prints for one session created in a fresh process. */
export interface FreshSessionReport {
	barrelLoaded: boolean;
	/** Zod module paths evaluated once `createAgentSession` resolved. */
	zodAtCreate: string[];
	/** Zod module paths evaluated once every active tool was converted to its wire schema. */
	zodAtWire: string[];
	/** Zod module paths evaluated once every built-in and hidden factory's tool was converted too. */
	zodAtEveryTool: string[];
	/** Built-in and hidden factories that returned no tool with every tool-enabling setting on. */
	unbuiltFactories: string[];
	tools: string[];
	commands: string[];
	authorPi: string | null;
	authorZod: string | null;
}

/**
 * Creates one agent session in a fresh process under `scratchDir` and returns what the fixture
 * reports. `author` passes one author inline extension. The fixture's stderr must be empty.
 */
export async function createSessionInFreshProcess(scratchDir: string, author: boolean): Promise<FreshSessionReport> {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE, scratchDir, ...(author ? ["author"] : [])], {
			env,
			timeout: 30_000,
			killSignal: "SIGKILL",
		});
		if (stderr !== "") throw new Error(`session fixture wrote to stderr:\n${stderr}`);
		return JSON.parse(stdout) as FreshSessionReport;
	} finally {
		cleanup();
	}
}
