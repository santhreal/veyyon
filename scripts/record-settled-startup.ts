import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { Process } from "@veyyon/natives";
import { type SettledStartupFrame, StartupFrameObserver } from "./startup-frame-observer";

export interface SettledStartupOptions {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	columns: number;
	rows: number;
	expectedModel: string;
	observationMs: number;
	stableMs: number;
	trace: string;
}

/** The command must disable PTY line-discipline echo before launching the CLI. */
export async function recordSettledStartup(options: SettledStartupOptions): Promise<SettledStartupFrame> {
	const observer = new StartupFrameObserver(options.columns, options.rows, options.expectedModel, "qjq");
	const completed = Promise.withResolvers<SettledStartupFrame>();
	const processState: { target: Process | null } = { target: null };
	let observing = true;
	let probed = false;
	let stderr = "";
	const started = performance.now();
	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.once("spawn", () => {
		processState.target = child.pid === undefined ? null : Process.fromPid(child.pid);
		if (!processState.target) completed.reject(new Error("Cannot retain a stable reference to the startup process"));
	});
	child.once("error", error => completed.reject(error));
	child.stdin.on("error", error => {
		if (observing) completed.reject(error);
	});
	child.once("exit", (code, signal) => {
		if (observing)
			completed.reject(new Error(`Startup exited before observation completed (${code ?? signal}): ${stderr}`));
	});
	observer.terminal.onData(data => {
		if (observing) child.stdin.write(data);
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		if (!observing) return;
		void observer.write(chunk, performance.now() - started).catch(completed.reject);
		if (!probed) {
			probed = true;
			// qjq is never sent literally: the editor must process deletion to produce it.
			child.stdin.write("qjX\x7fq");
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	const timer = setTimeout(() => {
		observing = false;
		void observer.finish(performance.now() - started, options.stableMs).then(completed.resolve, completed.reject);
	}, options.observationMs);
	const errors: unknown[] = [];
	let result: SettledStartupFrame | undefined;
	try {
		result = await completed.promise;
	} catch (error) {
		errors.push(error);
	} finally {
		observing = false;
		clearTimeout(timer);
		const target = processState.target;
		try {
			// The stable native reference includes descendants, including the shell
			// util-linux script creates in a different process group.
			if (target && !(await target.terminate({ gracefulMs: 500, timeoutMs: 2000 }))) {
				errors.push(new Error(`Startup process tree ${target.pid} did not terminate`));
			}
			if (!target && child.pid !== undefined) child.kill("SIGKILL");
		} catch (error) {
			errors.push(error);
		} finally {
			await observer.flush().catch(() => {});
			try {
				await fs.writeFile(
					options.trace,
					`${JSON.stringify(
						{
							columns: options.columns,
							rows: options.rows,
							expectedModel: options.expectedModel,
							observationMs: options.observationMs,
							stableMs: options.stableMs,
							stderr,
							samples: observer.samples,
						},
						null,
						2,
					)}\n`,
				);
			} catch (error) {
				errors.push(error);
			} finally {
				observer.dispose();
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
			}
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "Settled startup measurement failed");
	if (!result) throw new Error("Settled startup measurement produced no result");
	return result;
}
