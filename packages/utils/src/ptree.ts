import type { Spawn } from "bun";
import { processHandle } from "./native-process";
import { Exception, type InMask, type PipedSubprocess } from "./ptree-helpers";

import { readPipeText } from "./stream";
import { errorMessage } from "./type-guards";

export * from "./ptree-helpers";

export class NonZeroExitError extends Exception {
	static readonly MAX_TRACE = 32 * 1024;

	constructor(exitCode: number, stderr: string) {
		super(`Process exited with code ${exitCode}:\n${stderr}`, exitCode, stderr);
	}
	get aborted() {
		return false;
	}
}

export class ProcessAbortError extends Exception {
	constructor(
		public readonly reason: unknown,
		stderr: string,
	) {
		const msg = reason instanceof Error ? reason.message : String(reason ?? "aborted");
		super(`Operation cancelled: ${msg}`, -1, stderr);
		if (new.target === ProcessAbortError) {
			this.name = "AbortError";
		}
	}
	get aborted() {
		return true;
	}
}

export class TimeoutError extends ProcessAbortError {
	constructor(timeout: number, stderr: string) {
		super(new Error(`Timed out after ${Math.round(timeout / 1000)}s`), stderr);
	}
}

export interface WaitOptions {
	allowNonZero?: boolean;
	allowAbort?: boolean;
	stderr?: "full" | "buffer";
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	ok: boolean;
	exitError?: Exception;
}

export class ChildProcess<In extends InMask = InMask> {
	#nothrow = false;
	#stderrTail = "";
	#stderrChunks: Uint8Array[] = [];
	#exitReason?: Exception;
	#exitReasonPending?: Exception;
	#stderrDone: Promise<void>;
	#exited: Promise<number>;
	#stderrStream?: ReadableStream<Uint8Array>;

	constructor(
		readonly proc: PipedSubprocess<In>,
		readonly exposeStderr: boolean,
	) {
		const dec = new TextDecoder();
		const trim = () => {
			if (this.#stderrTail.length > NonZeroExitError.MAX_TRACE)
				this.#stderrTail = this.#stderrTail.slice(-NonZeroExitError.MAX_TRACE);
		};
		let stderrStream = proc.stderr;
		if (exposeStderr) {
			const [teeStream, drainStream] = stderrStream.tee();
			this.#stderrStream = teeStream;
			stderrStream = drainStream;
		}
		this.#stderrDone = (async () => {
			try {
				for await (const chunk of stderrStream) {
					this.#stderrChunks.push(chunk);
					this.#stderrTail += dec.decode(chunk, { stream: true });
					trim();
				}
			} catch (error) {
				this.#stderrTail += `\n[stderr capture stopped early: ${errorMessage(error)}]`;
			}
			this.#stderrTail += dec.decode();
			trim();
		})();

		const { promise, resolve, reject } = Promise.withResolvers<number>();
		this.#exited = promise;

		proc.exited
			.catch(() => null)
			.then(async exitCode => {
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}
				if (exitCode === 0) {
					resolve(0);
					return;
				}

				await this.#stderrDone;

				if (exitCode !== null) {
					this.#exitReason = new NonZeroExitError(exitCode, this.#stderrTail);
					resolve(exitCode);
					return;
				}

				const ex = this.proc.killed
					? new ProcessAbortError(new Error("process killed"), this.#stderrTail)
					: new NonZeroExitError(-1, this.#stderrTail);
				this.#exitReason = ex;
				reject(ex);
			});
	}

	get pid() {
		return this.proc.pid;
	}
	get exited() {
		return this.#exited;
	}
	get exitCode() {
		return this.proc.exitCode;
	}
	get exitReason() {
		return this.#exitReason;
	}
	get killed() {
		return this.proc.killed;
	}
	get stdin(): Bun.SpawnOptions.WritableToIO<In> {
		return this.proc.stdin;
	}

	get stdout() {
		return this.proc.stdout;
	}

	get stderr() {
		return this.#stderrStream;
	}

	get exitedCleanly(): Promise<number> {
		if (this.#nothrow) return this.#exited;
		return this.#exited.then(code => {
			if (code !== 0) throw new NonZeroExitError(code, this.#stderrTail);
			return code;
		});
	}

	peekStderr() {
		return this.#stderrTail;
	}

	nothrow(): this {
		this.#nothrow = true;
		return this;
	}

	kill(reason?: Exception) {
		if (reason && !this.#exitReasonPending) this.#exitReasonPending = reason;
		if (this.proc.killed) return;
		const handle = processHandle(this.proc.pid);
		if (handle) {
			void handle.terminate()?.catch(e => void e);
			return;
		}
		try {
			this.proc.kill();
		} catch {}
	}

	async text(): Promise<string> {
		const p = readPipeText(this.stdout);
		if (this.#nothrow) return p;
		const [text] = await Promise.all([p, this.exitedCleanly]);
		return text;
	}

	async blob(): Promise<Blob> {
		const p = new Response(this.stdout).blob();
		if (this.#nothrow) return p;
		const [blob] = await Promise.all([p, this.exitedCleanly]);
		return blob;
	}

	async json(): Promise<unknown> {
		return new Response(this.stdout).json();
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return new Response(this.stdout).arrayBuffer();
	}

	async bytes(): Promise<Uint8Array> {
		const body = await (
			new Response(this.stdout) as Response & { bytes(): Promise<Uint8Array | ArrayBuffer> }
		).bytes();
		return body instanceof Uint8Array ? body : new Uint8Array(body);
	}

	async wait(opts?: WaitOptions): Promise<ExecResult> {
		const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer" } = opts ?? {};

		let exitError: Exception | undefined;
		let fatalError: unknown;
		let hasFatal = false;
		const exitSettled = this.#exited.then(
			() => {},
			(err: unknown) => {
				if (err instanceof Exception) exitError = err;
				else {
					fatalError = err;
					hasFatal = true;
				}
			},
		);

		const stdoutP = readPipeText(this.stdout);
		const stderrP =
			stderrMode === "full"
				? this.#stderrDone.then(() => new TextDecoder().decode(Buffer.concat(this.#stderrChunks)))
				: this.#stderrDone.then(() => this.#stderrTail);

		const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

		await exitSettled;
		if (hasFatal) throw fatalError;

		if (!exitError) exitError = this.exitReason;
		if (!exitError && this.exitCode !== null && this.exitCode !== 0) {
			exitError = new NonZeroExitError(this.exitCode, this.#stderrTail);
		}

		const exitCode = exitError?.aborted ? null : (this.exitCode ?? exitError?.exitCode ?? null);
		const ok = exitCode === 0;

		if (exitError) {
			if ((exitError.aborted && !allowAbort) || (!exitError.aborted && !allowNonZero)) throw exitError;
		}

		return { stdout, stderr, exitCode, ok, exitError };
	}

	attachSignal(signal: AbortSignal): void {
		const onAbort = () => this.kill(new ProcessAbortError(signal.reason, "<cancelled>"));
		if (signal.aborted) return void onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		this.#exited.catch(() => {}).finally(() => signal.removeEventListener("abort", onAbort));
	}

	attachTimeout(ms: number): void {
		if (ms <= 0 || this.proc.killed) return;
		Promise.race([
			Bun.sleep(ms).then(() => true),
			this.proc.exited.then(
				() => false,
				() => false,
			),
		]).then(timedOut => {
			if (timedOut) this.kill(new TimeoutError(ms, this.#stderrTail));
		});
	}

	[Symbol.dispose](): void {
		if (this.proc.exitCode !== null) return;
		this.kill(new ProcessAbortError("process disposed", this.#stderrTail));
	}
}

type ChildSpawnOptions<In extends InMask = InMask> = Omit<
	Spawn.SpawnOptions<In, "pipe", "pipe">,
	"stdout" | "stderr" | "detached"
> & {
	signal?: AbortSignal;
	detached?: boolean;
	stderr?: "full" | null;
	onSpawnPid?: (pid: number) => void;
};

export function spawn<In extends InMask = InMask>(cmd: string[], opts?: ChildSpawnOptions<In>): ChildProcess<In> {
	const { timeout = -1, signal, stderr, onSpawnPid, ...rest } = opts ?? {};
	const child = Bun.spawn(cmd, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		...rest,
	});
	onSpawnPid?.(child.pid);
	const cp = new ChildProcess(child, stderr === "full");
	if (signal) cp.attachSignal(signal);
	if (timeout > 0) cp.attachTimeout(timeout);
	return cp;
}

export interface ExecOptions extends Omit<ChildSpawnOptions, "stderr" | "stdin">, WaitOptions {
	input?: string | Buffer | Uint8Array;
}

export async function exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
	const { input, stderr, allowAbort, allowNonZero, ...spawnOpts } = opts ?? {};
	const stdin = typeof input === "string" ? Buffer.from(input) : input;
	const resolved: ChildSpawnOptions = stdin === undefined ? spawnOpts : { ...spawnOpts, stdin };
	using child = spawn(cmd, resolved);
	return await child.wait({ stderr, allowAbort, allowNonZero });
}

type SignalValue = AbortSignal | null | undefined;

export function combineSignals(...signals: SignalValue[]): AbortSignal | undefined {
	let n = 0;
	for (let i = 0; i < signals.length; i++) {
		const s = signals[i];
		if (s instanceof AbortSignal) {
			if (s.aborted) return s;
			if (i !== n) signals[n] = s;
			n++;
		}
	}
	switch (n) {
		case 0:
			return undefined;
		case 1:
			return signals[0] as AbortSignal;
		default:
			return AbortSignal.any(signals.slice(0, n) as AbortSignal[]);
	}
}
