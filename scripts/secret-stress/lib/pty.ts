/**
 * Driving the real veyyon CLI through a real pseudo-terminal.
 *
 * WHY A PTY AND NOT A PIPE. Half of what this harness is looking for only exists when stdout is
 * a terminal: the TUI does not start at all behind a pipe, the masked value prompt is gated on
 * `isTTY`, and the crash under investigation unwinds a render path a pipe-mode run never reaches.
 * A pipe-mode run of the same scenario passes while the terminal one dies, which is exactly how
 * this class of bug shipped.
 *
 * WHY NOT tmux. Repo policy (AGENTS.md): a tmux capture is not evidence. tmux re-renders into
 * its own screen model and normalises the bytes, so it hides the difference between "the TUI drew
 * an error line" and "the TUI died". Everything here keeps the raw byte stream the child wrote to
 * its terminal, and every assertion runs against those bytes.
 *
 * The PTY is `PtySession` from `@veyyon/natives`, the same primitive the product's own
 * `bash pty: true` and `launch` use, so the terminal a scenario gets is the terminal a user gets.
 */
import { PtySession } from "@veyyon/natives";
import { CLI_ENTRY, type IsolatedRoot, isolatedArgv } from "./isolation";

/** Everything one PTY run produced. */
export interface PtyCapture {
	/** Raw bytes the child wrote to the terminal, escape sequences intact. */
	raw: string;
	/** The same stream with CSI/OSC sequences removed, for assertions a person can read. */
	plain: string;
	exitCode: number | undefined;
	timedOut: boolean;
	cancelled: boolean;
	/** Wall time in milliseconds, so a scenario can notice a hang that did not reach the timeout. */
	durationMs: number;
}

/**
 * Strip terminal control sequences.
 *
 * Deliberately narrow: CSI, OSC, single-character escapes and carriage returns. It does NOT
 * replay cursor motion, because collapsing a redraw into a final screen is precisely the
 * normalisation that makes tmux captures useless as evidence. Assertions run over everything the
 * child ever emitted, so a message that was printed and then overdrawn still counts as printed,
 * which is what matters when the question is "did it refuse".
 */
export function stripAnsi(text: string): string {
	return text
		.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001B[()][A-Za-z0-9]/g, "")
		.replace(/\u001B[=>NOM78]/g, "")
		.replace(/\r/g, "\n");
}

/** Arguments for a one-shot CLI run. */
export interface PtyRunSpec {
	iso: IsolatedRoot;
	args: readonly string[];
	/** Extra environment on top of the isolated root's, for `--from-env` scenarios. */
	env?: Record<string, string>;
	cwd?: string;
	timeoutMs?: number;
	cols?: number;
	rows?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

/** Run the CLI once in a PTY and collect everything it wrote before exiting. */
export async function runCli(spec: PtyRunSpec): Promise<PtyCapture> {
	const session = new PtySession();
	let raw = "";
	const started = performance.now();
	const { application, args } = isolatedArgv(spec.iso, [process.execPath, CLI_ENTRY, ...spec.args], spec.env);
	const result = await session.startArgv(
		{
			application,
			args,
			cwd: spec.cwd ?? spec.iso.project,
			timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			cols: spec.cols ?? DEFAULT_COLS,
			rows: spec.rows ?? DEFAULT_ROWS,
		},
		(_error, chunk) => {
			raw += chunk;
		},
	);
	return {
		raw,
		plain: stripAnsi(raw),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		cancelled: result.cancelled,
		durationMs: performance.now() - started,
	};
}

/**
 * Keys the TUI reads, spelled the way a terminal actually sends them.
 *
 * `\r` and not `\n`: Enter is carriage return on a terminal, and the TUI's key decoder ignores a
 * bare line feed, so a driver that sends `\n` types a command that is never submitted and then
 * reports that the command "did nothing".
 */
export const KEY = {
	enter: "\r",
	escape: "\u001B",
	/** Clear the whole input line, so one step cannot inherit a previous step's half-typed text. */
	clearLine: "\u0015",
	tab: "\t",
	ctrlC: "\u0003",
	up: "\u001B[A",
	down: "\u001B[B",
} as const;

/**
 * A live interactive TUI in a PTY, which the caller types into.
 *
 * The interesting scenarios are stateful: store a secret, let a SECOND process mutate the vault
 * underneath, then type again and see whether the session survives. That needs a session that
 * stays up between steps, which a one-shot run cannot give.
 */
export class InteractiveCli {
	#session = new PtySession();
	#raw = "";
	#run: Promise<{ exitCode?: number; cancelled: boolean; timedOut: boolean }> | null = null;
	#settled: { exitCode?: number; cancelled: boolean; timedOut: boolean } | null = null;
	#failure: unknown = null;

	constructor(
		readonly iso: IsolatedRoot,
		readonly args: readonly string[] = [],
		readonly options: { env?: Record<string, string>; timeoutMs?: number; cols?: number; rows?: number } = {},
	) {}

	/** Launch. Returns once the child has been started; use {@link waitFor} to await readiness. */
	start(): void {
		if (this.#run) throw new Error("InteractiveCli already started");
		const { application, args } = isolatedArgv(
			this.iso,
			[process.execPath, CLI_ENTRY, ...this.args],
			this.options.env,
		);
		this.#run = this.#session
			.startArgv(
				{
					application,
					args,
					cwd: this.iso.project,
					timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					cols: this.options.cols ?? DEFAULT_COLS,
					rows: this.options.rows ?? DEFAULT_ROWS,
				},
				(_error, chunk) => {
					this.#raw += chunk;
				},
			)
			.then(
				result => {
					this.#settled = result;
					return result;
				},
				error => {
					this.#failure = error;
					this.#settled = { cancelled: true, timedOut: false };
					return this.#settled;
				},
			);
	}

	/** Everything the child has written so far, escape sequences intact. */
	get raw(): string {
		return this.#raw;
	}

	/** Everything the child has written so far, control sequences removed. */
	get plain(): string {
		return stripAnsi(this.#raw);
	}

	/** Whether the child process has exited. */
	get exited(): boolean {
		return this.#settled !== null;
	}

	/** The exit result once the child is gone, otherwise `null`. */
	get result(): { exitCode?: number; cancelled: boolean; timedOut: boolean } | null {
		return this.#settled;
	}

	/** A PTY-level error, when the session itself failed rather than the child. */
	get failure(): unknown {
		return this.#failure;
	}

	/** Type raw bytes. */
	send(data: string): void {
		this.#session.write(data);
	}

	/**
	 * Type a line into the composer and submit it.
	 *
	 * Escape before Enter is REQUIRED, not defensive. Typing `/secret` opens the slash-command
	 * completion popup, and while that popup is open Enter ACCEPTS THE COMPLETION instead of
	 * submitting: a driver without the escape produces `/secret list  /secret list` in the
	 * composer and never runs anything. Verified in a real PTY before it was written down.
	 */
	async submit(text: string, options: { typeDelayMs?: number; afterMs?: number } = {}): Promise<void> {
		this.send(KEY.clearLine);
		await Bun.sleep(200);
		this.send(text);
		await Bun.sleep(options.typeDelayMs ?? 800);
		this.send(KEY.escape);
		await Bun.sleep(300);
		this.send(KEY.enter);
		await Bun.sleep(options.afterMs ?? 1_500);
	}

	/**
	 * Wait until the accumulated output matches, or the child exits, or time runs out.
	 *
	 * Returns the reason it stopped rather than throwing, because "the child exited while we
	 * waited for a prompt" is a RESULT this harness is hunting for, not an infrastructure error.
	 */
	async waitFor(pattern: RegExp | string, timeoutMs = 30_000): Promise<"matched" | "exited" | "timeout"> {
		const matches = (): boolean =>
			typeof pattern === "string" ? this.plain.includes(pattern) : pattern.test(this.plain);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (matches()) return "matched";
			if (this.#settled) return matches() ? "matched" : "exited";
			await Bun.sleep(50);
		}
		return matches() ? "matched" : "timeout";
	}

	/** Wait for the child to exit on its own. */
	async waitForExit(timeoutMs = 20_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.#settled) return true;
			await Bun.sleep(50);
		}
		return false;
	}

	/** Wait for output to stop changing, so a scenario reads a settled screen rather than a partial one. */
	async settle(quietMs = 800, maxMs = 20_000): Promise<void> {
		const deadline = Date.now() + maxMs;
		let last = this.#raw.length;
		let quietSince = Date.now();
		while (Date.now() < deadline) {
			await Bun.sleep(100);
			if (this.#settled) return;
			if (this.#raw.length !== last) {
				last = this.#raw.length;
				quietSince = Date.now();
				continue;
			}
			if (Date.now() - quietSince >= quietMs) return;
		}
	}

	/** Shut the child down and collect its capture. */
	async close(): Promise<PtyCapture> {
		if (!this.#settled) {
			try {
				this.#session.kill();
			} catch {}
			await Promise.race([this.#run, Bun.sleep(3_000)]);
		}
		return {
			raw: this.#raw,
			plain: stripAnsi(this.#raw),
			exitCode: this.#settled?.exitCode,
			timedOut: this.#settled?.timedOut ?? false,
			cancelled: this.#settled?.cancelled ?? true,
			durationMs: 0,
		};
	}
}
