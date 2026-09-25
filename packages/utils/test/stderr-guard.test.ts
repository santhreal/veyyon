import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { $which } from "../src/which";

/**
 * WHY. The renderer tracks the rows it painted, so any byte it did not write
 * shifts the composer down and strands old frames in scrollback. Four paths
 * put such bytes on the terminal: native stderr (Rust `eprintln!` in the addon,
 * libmalloc, runtime warnings), JavaScript stderr (`console.error`, `warn`,
 * `trace`, `process.stderr.write`), JavaScript stdout text (`console.log`,
 * `info`, `debug`, `dir`), and a worker thread's console, which Bun writes
 * straight to fd 1 and fd 2. The guard was macOS-only and fd-only, so on Linux
 * and Windows the first three reached the viewport, and the fourth reached it
 * everywhere; the reported case was a loader warning printed with
 * `console.error` on Windows.
 *
 * Closed here: while the guard is active, every member of the first three paths
 * lands in the redirect target and nothing reaches the process's stdout or
 * stderr; a worker thread's console lands there for the worker's whole life
 * while the main thread's is untouched; restore sends each path back to the
 * real stream; a `write` callback still fires; and without `force`, a stream
 * that is not the terminal is left alone. The console methods are swept from
 * one list, so a method added to the router without a probe here, or dropped
 * from it, turns the suite red.
 *
 * NOT closed here: `fs.writeSync(2, …)` from JavaScript on Windows, which goes
 * through Bun's own fd table rather than the standard handle; a stdout write
 * made through `process.stdout.write`, which is the renderer's own channel and
 * cannot be told apart from a frame; and that the CLI calls
 * `routeWorkerThreadOutput` for every worker kind, which is a single call at
 * the top of its worker dispatch rather than something this suite can sweep.
 *
 * Every probe runs in a subprocess so the test runner's own streams are never
 * mutated.
 */

const GUARD_MODULE = path.resolve(import.meta.dir, "../src/stderr-guard.ts");

/** Every console method the guard routes, and the stream each writes to when not routed. */
const CONSOLE_METHODS = [
	["log", "stdout"],
	["info", "stdout"],
	["debug", "stdout"],
	["dir", "stdout"],
	["warn", "stderr"],
	["error", "stderr"],
	["trace", "stderr"],
] as const;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * A native write to the process's standard error, the way Rust's `eprintln!`
 * makes it: fd 2 on POSIX, the handle `GetStdHandle` returns on Windows.
 */
const NATIVE_WRITE = [
	`import { dlopen, FFIType } from "bun:ffi";`,
	`import * as fs from "node:fs";`,
	`const k32 = process.platform === "win32" ? dlopen("kernel32.dll", {`,
	`	GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },`,
	`	WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },`,
	`}).symbols : null;`,
	`function nativeWrite(text) {`,
	`	if (!k32) { fs.writeSync(2, text); return; }`,
	`	const bytes = Buffer.from(text);`,
	`	const written = new Uint32Array(1);`,
	`	k32.WriteFile(k32.GetStdHandle(0xfffffff4), bytes, bytes.length, written, 0n);`,
	`}`,
].join("\n");

async function runProbe(
	body: string[],
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number; report: Record<string, unknown> }> {
	const dir = tempDir();
	const probePath = path.join(dir, "probe.ts");
	fs.writeFileSync(
		probePath,
		[
			`import { isTerminalOutputRouted, isTerminalStderrSuppressed, restoreTerminalStderr, routeWorkerThreadOutput, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
			NATIVE_WRITE,
			`const redirectPath = process.argv[2];`,
			...body,
		].join("\n"),
	);
	const proc = Bun.spawn([process.execPath, probePath, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	const marker = stdout.lastIndexOf("REPORT:");
	const report = marker === -1 ? {} : (JSON.parse(stdout.slice(marker + "REPORT:".length)) as Record<string, unknown>);
	return { stdout: marker === -1 ? stdout : stdout.slice(0, marker), stderr, exitCode, report };
}

describe("the terminal output guard", () => {
	it("redirects native stderr while active, restores it after, and leaves a piped stderr alone without force", async () => {
		const redirectPath = path.join(tempDir(), "redirect.log");
		const { stderr, exitCode, report } = await runProbe(
			[
				`nativeWrite("before\\n");`,
				`// stderr is a pipe here, so the same-terminal gate must refuse.`,
				`const gateResult = suppressTerminalStderr();`,
				`const forced = suppressTerminalStderr({ force: true, redirectPath });`,
				`const suppressedWhileActive = isTerminalStderrSuppressed();`,
				`nativeWrite("hidden\\n");`,
				`// Idempotent while active: must not stack a second saved stream.`,
				`const secondSuppress = suppressTerminalStderr({ force: true, redirectPath });`,
				`restoreTerminalStderr();`,
				`nativeWrite("after\\n");`,
				`// Restore without active suppression is a no-op.`,
				`restoreTerminalStderr();`,
				`nativeWrite("still-visible\\n");`,
				`process.stdout.write("REPORT:" + JSON.stringify({ gateResult, forced, secondSuppress, suppressedWhileActive, suppressedAfterRestore: isTerminalStderrSuppressed() }));`,
			],
			[redirectPath],
		);

		expect(exitCode).toBe(0);
		// Every platform the product ships on has a native redirect.
		expect(report).toEqual({
			gateResult: false,
			forced: true,
			secondSuppress: true,
			suppressedWhileActive: true,
			suppressedAfterRestore: false,
		});
		expect(stderr).toBe("before\nafter\nstill-visible\n");
		expect(fs.readFileSync(redirectPath, "utf8")).toBe("hidden\n");
	});

	it("routes every console method and process.stderr.write to the log while active, and back after restore", async () => {
		const redirectPath = path.join(tempDir(), "redirect.log");
		const calls = CONSOLE_METHODS.map(([method]) =>
			method === "dir" ? `console.dir({ routed: "dir" });` : `console.${method}("routed-${method}");`,
		);
		const { stdout, stderr, exitCode, report } = await runProbe(
			[
				`suppressTerminalStderr({ force: true, redirectPath });`,
				`const routedWhileActive = isTerminalOutputRouted();`,
				...calls,
				`const written = Promise.withResolvers();`,
				`const writeResult = process.stderr.write("routed-stderr-write\\n", () => written.resolve(true));`,
				`process.stderr.write(new TextEncoder().encode("routed-stderr-bytes\\n"));`,
				`// A callback that never fires hangs here, and the test times out on it.`,
				`const callbackFired = await written.promise;`,
				`restoreTerminalStderr();`,
				`console.log("visible-log");`,
				`console.error("visible-error");`,
				`process.stderr.write("visible-stderr-write\\n");`,
				`process.stdout.write("REPORT:" + JSON.stringify({ routedWhileActive, routedAfterRestore: isTerminalOutputRouted(), writeResult, callbackFired }));`,
			],
			[redirectPath],
		);

		expect(exitCode).toBe(0);
		expect(report).toEqual({
			routedWhileActive: true,
			routedAfterRestore: false,
			writeResult: true,
			callbackFired: true,
		});
		expect(stdout).toBe("visible-log\n");
		expect(stderr).toBe("visible-error\nvisible-stderr-write\n");

		// Tagged by the router, so a line here proves the JavaScript route and not the fd-2
		// redirect, which on POSIX would catch the stderr methods on its own.
		const logged = fs.readFileSync(redirectPath, "utf8");
		for (const [method] of CONSOLE_METHODS) {
			const text =
				method === "dir" ? "{ routed: 'dir' }" : method === "trace" ? "Trace: routed-trace" : `routed-${method}`;
			expect(logged).toContain(`[console.${method}] ${text}\n`);
		}
		expect(logged).toContain("[process.stderr] routed-stderr-write\n");
		expect(logged).toContain("[process.stderr] routed-stderr-bytes\n");
		expect(logged).not.toContain("visible-");
	});

	it("routes nothing when neither stream is the terminal and force is not given", async () => {
		const redirectPath = path.join(tempDir(), "redirect.log");
		const { stdout, stderr, exitCode, report } = await runProbe(
			[
				`suppressTerminalStderr({ redirectPath });`,
				`const routed = isTerminalOutputRouted();`,
				`console.log("piped-log");`,
				`console.error("piped-error");`,
				`process.stdout.write("REPORT:" + JSON.stringify({ routed }));`,
			],
			[redirectPath],
		);

		expect(exitCode).toBe(0);
		expect(report).toEqual({ routed: false });
		expect(stdout).toBe("piped-log\n");
		expect(stderr).toBe("piped-error\n");
		expect(fs.existsSync(redirectPath)).toBe(false);
	});

	it("routes a worker thread's console to the log for its whole life and leaves the main thread's alone", async () => {
		const dir = tempDir();
		const redirectPath = path.join(dir, "redirect.log");
		fs.writeFileSync(
			path.join(dir, "worker.ts"),
			[
				`import { routeWorkerThreadOutput } from ${JSON.stringify(GUARD_MODULE)};`,
				`routeWorkerThreadOutput({ redirectPath: ${JSON.stringify(redirectPath)} });`,
				...CONSOLE_METHODS.map(([method]) =>
					method === "dir" ? `console.dir({ worker: "dir" });` : `console.${method}("worker-${method}");`,
				),
				`process.stderr.write("worker-stderr-write\\n");`,
				`postMessage("done");`,
			].join("\n"),
		);
		const { stdout, stderr, exitCode, report } = await runProbe(
			[
				`// A no-op on the main thread.`,
				`routeWorkerThreadOutput({ redirectPath });`,
				`const mainRouted = isTerminalOutputRouted();`,
				`const worker = new Worker(${JSON.stringify(path.join(dir, "worker.ts"))}, { type: "module" });`,
				`const done = Promise.withResolvers();`,
				`worker.onmessage = () => done.resolve();`,
				`await done.promise;`,
				`worker.terminate();`,
				`console.log("main-log");`,
				`console.error("main-error");`,
				`process.stdout.write("REPORT:" + JSON.stringify({ mainRouted }));`,
			],
			[redirectPath],
		);

		expect(exitCode).toBe(0);
		expect(report).toEqual({ mainRouted: false });
		expect(stdout).toBe("main-log\n");
		expect(stderr).toBe("main-error\n");
		const logged = fs.readFileSync(redirectPath, "utf8");
		for (const [method] of CONSOLE_METHODS) {
			const text =
				method === "dir" ? "{ worker: 'dir' }" : method === "trace" ? "Trace: worker-trace" : `worker-${method}`;
			expect(logged).toContain(`[console.${method}] ${text}\n`);
		}
		expect(logged).toContain("[process.stderr] worker-stderr-write\n");
	});

	/**
	 * Run a probe on a real terminal. `script` allocates a PTY and points the
	 * probe's stdout and stderr at it, which is the situation the TUI runs in;
	 * `stderrTo` redirects stderr away from it the way `2>file` does.
	 */
	async function runInTerminal(stderrTo?: string): Promise<{ terminal: string; exitCode: number; logged: string }> {
		const dir = tempDir();
		const redirectPath = path.join(dir, "redirect.log");
		const probePath = path.join(dir, "tty-probe.ts");
		fs.writeFileSync(
			probePath,
			[
				`import { restoreTerminalStderr, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
				NATIVE_WRITE,
				`suppressTerminalStderr({ redirectPath: process.argv[2] });`,
				`console.log("tty-log");`,
				`console.error("tty-error");`,
				`process.stderr.write("tty-stderr-write\\n");`,
				`nativeWrite("tty-native\\n");`,
				`restoreTerminalStderr();`,
				`process.stdout.write("tty-done\\n");`,
			].join("\n"),
		);
		const redirect = stderrTo ? ` 2>${JSON.stringify(stderrTo)}` : "";
		const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(probePath)} ${JSON.stringify(redirectPath)}${redirect}`;
		const proc = Bun.spawn(["script", "-qec", command, "/dev/null"], { stdout: "pipe", stderr: "pipe" });
		const [terminal, , exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		const logged = fs.existsSync(redirectPath) ? fs.readFileSync(redirectPath, "utf8") : "";
		return { terminal: terminal.replaceAll("\r", ""), exitCode, logged };
	}

	const noPty = process.platform !== "linux" || !$which("script");

	it.skipIf(noPty)("engages on its own when stdout and stderr are the same terminal", async () => {
		const { terminal, exitCode, logged } = await runInTerminal();

		expect(exitCode).toBe(0);
		expect(terminal).toBe("tty-done\n");
		expect(logged).toContain("[console.log] tty-log\n");
		expect(logged).toContain("[console.error] tty-error\n");
		expect(logged).toContain("[process.stderr] tty-stderr-write\n");
		expect(logged).toContain("tty-native\n");
	});

	it.skipIf(noPty)("routes stdout text but leaves a stderr the user redirected untouched", async () => {
		const stderrFile = path.join(tempDir(), "stderr.txt");
		const { terminal, exitCode, logged } = await runInTerminal(stderrFile);

		expect(exitCode).toBe(0);
		expect(terminal).toBe("tty-done\n");
		expect(logged).toBe("[console.log] tty-log\n");
		// Bun colours `console.error` whenever stdout is a terminal, even into a file; the text is the contract.
		expect(stripVTControlCharacters(fs.readFileSync(stderrFile, "utf8"))).toBe(
			"tty-error\ntty-stderr-write\ntty-native\n",
		);
	});
});
