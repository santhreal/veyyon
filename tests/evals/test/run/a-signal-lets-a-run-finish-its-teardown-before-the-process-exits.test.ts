/**
 * WHY: `@veyyon/utils/postmortem` handles SIGINT and SIGTERM in every process that loads it: it runs
 * the registered cleanups and exits. The runner listened on the signals itself and lost that race, so
 * a stopped run exited mid-trial: its trials' process trees kept running, their scratch directories
 * stayed on disk, their journal rows were never written, and nothing was said on stderr.
 *
 * `runUnderSignals` makes the run a registered cleanup. These cases run it in a child process with a
 * run that tears down slowly once aborted, signal the child, and assert that the teardown finished
 * before the process exited, that the interruption was reported with the run's result, and that the
 * exit code is the signal's. A run that no signal reaches returns normally and reports nothing.
 *
 * Not caught: SIGHUP, and a teardown longer than postmortem's 10 s deadline, after which postmortem
 * exits regardless.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";

const INTERRUPT_MODULE = path.join(import.meta.dirname, "..", "..", "engine", "run", "interrupt.ts");

/** A run that says it started, waits to be aborted, then takes half a second to tear down. */
function script(marker: string, waitForAbort: boolean): string {
	return `import * as fs from "node:fs";
import { runUnderSignals } from ${JSON.stringify(INTERRUPT_MODULE)};
const outcome = await runUnderSignals(
	"probe-run",
	async signal => {
		console.log("started");
		if (${waitForAbort}) {
			const { promise, resolve } = Promise.withResolvers();
			signal.addEventListener("abort", resolve);
			await promise;
			await Bun.sleep(500);
			fs.writeFileSync(${JSON.stringify(marker)}, "torn down");
		}
		return 3;
	},
	(signal, result) => fs.writeSync(2, "interrupted by " + signal + " after " + result + "\\n"),
);
console.log("returned " + outcome.interrupted);
`;
}

interface Exit {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run the script, sending `signal` once it has said it started. */
async function runScript(file: string, signal: NodeJS.Signals | null): Promise<Exit> {
	const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let sent = false;
	child.stdout.on("data", chunk => {
		stdout += chunk;
		if (signal && !sent && stdout.includes("started")) {
			sent = true;
			child.kill(signal);
		}
	});
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const { promise, resolve } = Promise.withResolvers<Exit>();
	child.on("close", code => resolve({ code, stdout, stderr }));
	return await promise;
}

describe("a run under signals", () => {
	for (const [signal, code] of [
		["SIGTERM", 143],
		["SIGINT", 130],
	] as const) {
		it(`finishes its teardown and reports before the process exits on ${signal}`, async () => {
			await using dir = await TempDir.create("@evals-signal-");
			const marker = dir.join("marker");
			const file = dir.join("run.ts");
			await fs.writeFile(file, script(marker, true));

			const exit = await runScript(file, signal);

			expect(exit.code).toBe(code);
			expect(await fs.readFile(marker, "utf8")).toBe("torn down");
			expect(exit.stderr).toBe(`interrupted by ${signal} after 3\n`);
		});
	}

	it("returns what the run returned, and reports nothing, when no signal arrives", async () => {
		await using dir = await TempDir.create("@evals-signal-");
		const file = dir.join("run.ts");
		await fs.writeFile(file, script(dir.join("marker"), false));

		const exit = await runScript(file, null);

		expect(exit).toEqual({ code: 0, stdout: "started\nreturned null\n", stderr: "" });
	});
});
