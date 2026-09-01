/**
 * Startup benchmark: how long veyyon takes to put something on the screen.
 *
 * Eight arms, cheapest first, so a regression can be attributed to a layer:
 *
 *   version      `--version`, which returns before the command registry loads. Runtime init plus
 *                the entry module's own graph, and nothing else.
 *   help         `--help`, which loads the command registry. version + registry.
 *   ready        an interactive launch with `VEYYON_TIMING=x`, which prints the startup timing tree
 *                and exits at the point the TUI would take the terminal. Everything the boot path
 *                does before the first frame, minus the frame itself.
 *   first-frame  an interactive launch under a pty, timed from spawn to the first byte the process
 *                writes, with no first-frame recording on disk. The card is composed.
 *   composer     the same launch, timed to the composer's own placeholder row being on screen.
 *   editable     the same launch, timed to a character typed after the first byte coming back
 *                echoed. This is the moment the terminal answers the operator, and no output-only
 *                timer can observe it.
 *   statusrow    the same launch, timed to the status row being on screen — the row carrying where
 *                you are, the model, the mode and the context gauge.
 *   replay       the same launch again, against the recording the launch before it wrote. The card
 *                is replayed rather than composed.
 *   replay:*     composer, editable and statusrow on that replayed launch. The replayed card is
 *                bytes, so these say when it stops being a picture and starts answering.
 *
 * `first-frame` and `replay` are the off and on arms of the first-frame replay, at exact parity:
 * one binary, one seeded home, one terminal size, two consecutive launches, and the recording is
 * the only difference between them. `first-frame` deletes the recording before it spawns, so it
 * reports the composed number rather than whichever state the arm before it left behind.
 *
 * A FIRST BYTE IS NOT A USABLE SCREEN, which is why `composer`, `editable`, `statusrow` and the
 * `replay:*` arms exist. `first-frame` was the whole answer here and it reads 45-46ms on a warm
 * binary: optimizing against it alone declares victory on a frame the operator cannot yet read.
 * The replay arm read the first byte only, which was that same mistake one layer down.
 *
 * `statusrow` used to trail the frame by about a second, because the row belonged to the session
 * and the card painted a hand-written `path · git` in its place. The card now renders the real row
 * from config, so the arm reads at the frame instead. A run where it trails again means the card
 * stopped painting it.
 *
 * Each arm runs against an isolated agent home so the numbers do not depend on the machine's
 * accumulated caches, sessions, or vault, and so a run cannot touch them. `--cold` throws that home
 * away between repetitions, which is the install-day number; the default keeps it, which is the
 * number a returning user sees. The two differ by more than a factor of three on the machine this
 * was written on, so a report that does not say which one it measured says nothing.
 *
 * Usage:
 *   bun scripts/bench-startup.ts [--runs 5] [--cold] [--bin <veyyon>] [--json out.json]
 *
 * `--bin` measures a built binary instead of `bun <source>`; the source arm carries Bun's own
 * transpile cost and is the pessimistic reading.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_SOURCE = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
/** Onboarding generation the seeded home claims to have finished, so no run measures the wizard. */
const ONBOARDED_CONFIG = "onboardingVersion: 1\n";

interface Options {
	runs: number;
	cold: boolean;
	bin?: string;
	json?: string;
	timeoutMs: number;
}

interface Sample {
	arm: string;
	ms: number;
}

function parseArgs(argv: string[]): Options {
	const options: Options = { runs: 5, cold: false, timeoutMs: 60_000 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--runs") options.runs = Number(argv[++i]);
		else if (arg === "--cold") options.cold = true;
		else if (arg === "--bin") options.bin = argv[++i];
		else if (arg === "--json") options.json = argv[++i];
		else if (arg === "--timeout") options.timeoutMs = Number(argv[++i]) * 1000;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isFinite(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
	return options;
}

/** The command that launches veyyon: a built binary when given one, else the source entry under Bun. */
function launcher(options: Options): { command: string; prefix: string[] } {
	return options.bin ? { command: options.bin, prefix: [] } : { command: "bun", prefix: [CLI_SOURCE] };
}

/**
 * A pty wrapper, because the interactive arms refuse to run without a terminal and neither Node nor
 * Bun can allocate one. `script` ships with util-linux and with macOS, and its argument order
 * differs between them.
 *
 * `stty -echo` FIRST, because the line discipline echoes typed input on its own and the `editable`
 * arms cannot tell that apart from the composer answering. With echo left on, `sh -c 'printf X;
 * sleep 2'` returns the probe in 1.1ms and scores better than veyyon: the arm reads the kernel, not
 * the program, on every launch that has not yet taken the terminal into raw mode. Turning it off
 * means an echo observed here was written by the process under test.
 */
function ptyWrapper(command: string, args: string[]): { command: string; args: string[] } {
	const quoted = [command, ...args].map(part => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
	const withoutEcho = `stty -echo 2>/dev/null; exec ${quoted}`;
	return os.platform() === "darwin"
		? { command: "script", args: ["-q", "/dev/null", "/bin/sh", "-c", withoutEcho] }
		: { command: "script", args: ["-qec", withoutEcho, "/dev/null"] };
}

interface RunOutcome {
	ms: number;
	stdout: string;
}

/**
 * Typed into the launch composer to prove it answers. Three characters that occur nowhere in the
 * launch card's art, its copy or a path, so an echo cannot be mistaken for the card repainting.
 */
const PROBE = "qjq";
/**
 * How long a recorded launch is held open before it is killed. Generous rather than tight: an arm
 * that has not fired by the kill is reported as absent rather than slow, which reads as the arm
 * disappearing from the table instead of as a regression.
 */
const FRAME_HOLD_MS = 4000;

interface FrameMarks {
	firstByte?: number;
	composer?: number;
	editable?: number;
	statusrow?: number;
}

/**
 * Record one interactive launch under a pty and timestamp the moments a person waits for.
 *
 * Stdin is a pipe rather than `ignore` because the editable arm has to type: the probe goes in as
 * soon as the first byte lands, so the echo timestamp measures when the composer became able to
 * answer and not how long this harness waited before asking.
 *
 * `probe: false` withholds it, which the replay arms need. A launch the operator typed into records
 * nothing, because what is on screen at the end of it is a draft rather than a card the next launch
 * can replay, so a typing launch can never leave the recording the replay arm measures against.
 * Those arms want the first byte only, and the first byte is timed before any probe would be sent.
 *
 * The markers are read off a recorded stream rather than assumed:
 *   composer    the composer's placeholder row, which nothing else draws
 *   statusrow   the context gauge, which is on every preset's status row and nowhere else on the
 *               screen. Matched as the glyph OR the words, so a preset rendering the ascii bar
 *               still trips it.
 */
async function recordFrame(
	command: string,
	args: string[],
	env: Record<string, string>,
	holdMs: number,
	probe = true,
): Promise<FrameMarks> {
	const marks: FrameMarks = {};
	const started = performance.now();
	const child = spawn(command, args, {
		cwd: REPO_ROOT,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});

	let seen = "";
	const at = (): number => performance.now() - started;
	const onData = (chunk: string): void => {
		seen += chunk;
		if (marks.firstByte === undefined) {
			marks.firstByte = at();
			if (probe) child.stdin.write(PROBE);
		}
		if (marks.composer === undefined && seen.includes("ask anything")) marks.composer = at();
		if (marks.editable === undefined && seen.includes(PROBE)) marks.editable = at();
		if (marks.statusrow === undefined && /▰|% left/.test(seen)) marks.statusrow = at();
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", onData);
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", onData);

	const held = Promise.withResolvers<void>();
	setTimeout(held.resolve, holdMs);
	await held.promise;
	child.kill("SIGKILL");
	return marks;
}

/**
 * Spawn one process and stop timing at `until`: the first byte for the pty arms, process exit for
 * the rest. The child is killed the moment the number is captured — an interactive launch never
 * ends on its own, and nothing after the first byte is being measured.
 */
async function timeRun(
	command: string,
	args: string[],
	env: Record<string, string>,
	until: "first-byte" | "exit",
	timeoutMs: number,
): Promise<RunOutcome> {
	const { promise, resolve, reject } = Promise.withResolvers<RunOutcome>();
	const started = performance.now();
	let ms: number | undefined;
	let stdout = "";
	let settled = false;

	const child = spawn(command, args, {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});

	const finish = (): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (ms === undefined) reject(new Error(`no output before exit: ${stdout.slice(-300)}`));
		else resolve({ ms, stdout });
	};

	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		if (!settled) {
			settled = true;
			reject(new Error(`timed out after ${timeoutMs}ms`));
		}
	}, timeoutMs);

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (until !== "first-byte" || ms !== undefined) return;
		ms = performance.now() - started;
		child.kill("SIGKILL");
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.on("error", err => {
		clearTimeout(timer);
		if (!settled) {
			settled = true;
			reject(err);
		}
	});
	child.on("close", () => {
		if (until === "exit") ms = performance.now() - started;
		finish();
	});

	return promise;
}

/** A seeded agent home: onboarded, empty of everything else. */
async function seedHome(root: string): Promise<string> {
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, ".veyyon"), { recursive: true });
	await fs.writeFile(path.join(home, ".veyyon", "config.yml"), ONBOARDED_CONFIG);
	return home;
}

/** `Total: 394.3ms` from the timing tree the `ready` arm prints. */
function parseInstrumentedTotal(stdout: string): number | undefined {
	const match = /Total:\s+([0-9.]+)ms/.exec(stdout);
	return match ? Number(match[1]) : undefined;
}

/** `(before instrumentation): 511ms` — runtime init plus module load, before the first marker. */
function parseBeforeInstrumentation(stdout: string): number | undefined {
	const match = /\(before instrumentation\):\s+([0-9.]+)ms/.exec(stdout);
	return match ? Number(match[1]) : undefined;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function report(arm: string, samples: number[]): string {
	if (samples.length === 0) return `${arm}: no samples`;
	return (
		`${arm.padEnd(12)} median ${median(samples).toFixed(0)}ms ` +
		`(min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)}, n=${samples.length})`
	);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const { command, prefix } = launcher(options);
	const scratch = path.join(REPO_ROOT, ".captures", "bench-startup");
	await fs.rm(scratch, { recursive: true, force: true });
	await fs.mkdir(scratch, { recursive: true });

	const samples: Sample[] = [];
	const push = (arm: string, ms: number): void => {
		samples.push({ arm, ms });
	};

	/**
	 * The first-frame recording, kept inside the scratch directory.
	 *
	 * Named explicitly because the seeded `HOME` does not reach it: the recording resolves its path
	 * from `os.homedir()`, which Bun fixes at process start, so a launch spawned with `HOME` set
	 * still writes to the operator's own cache. Without this the bench would both pollute that cache
	 * and read whichever recording the operator's last real launch left there.
	 */
	const recording = path.join(scratch, "first-frame.json");

	/**
	 * `--cold` means every arm pays install-day cost, so the home is thrown away before each arm
	 * rather than each run: the GPU probe, the model catalog and the session store are all caches one
	 * arm would otherwise warm for the next, which turned a cold first-frame number into a warm one.
	 */
	async function envFor(): Promise<Record<string, string>> {
		if (options.cold) await fs.rm(path.join(scratch, "home"), { recursive: true, force: true });
		const home = await seedHome(scratch);
		return {
			HOME: home,
			TERM: "xterm-256color",
			VEYYON_PROFILE: "",
			VEYYON_FIRST_FRAME_CACHE: recording,
		};
	}

	for (let run = 0; run < options.runs; run++) {
		let env = await envFor();

		push("version", (await timeRun(command, [...prefix, "--version"], env, "exit", options.timeoutMs)).ms);

		env = await envFor();
		push("help", (await timeRun(command, [...prefix, "--help"], env, "exit", options.timeoutMs)).ms);

		env = await envFor();
		const readyPty = ptyWrapper(command, prefix);
		const ready = await timeRun(
			readyPty.command,
			readyPty.args,
			{ ...env, VEYYON_TIMING: "x" },
			"exit",
			options.timeoutMs,
		);
		push("ready", ready.ms);
		const total = parseInstrumentedTotal(ready.stdout);
		const before = parseBeforeInstrumentation(ready.stdout);
		if (total !== undefined) push("ready:boot", total);
		if (before !== undefined) push("ready:load", before);

		env = await envFor();
		const framePty = ptyWrapper(command, prefix);
		// One recorded launch answers all four: the arms are moments in a single
		// frame's life, and timing them separately would spend four launches to
		// compare numbers from four different processes.
		//
		// The recording goes first, so this arm composes the card whatever the arm before it left
		// behind. This launch types, so it leaves no recording of its own.
		await fs.rm(recording, { force: true });
		const marks = await recordFrame(framePty.command, framePty.args, env, FRAME_HOLD_MS);
		if (marks.firstByte !== undefined) push("first-frame", marks.firstByte);
		if (marks.composer !== undefined) push("composer", marks.composer);
		if (marks.editable !== undefined) push("editable", marks.editable);
		if (marks.statusrow !== undefined) push("statusrow", marks.statusrow);

		// The recording the replay arm measures against, written by a launch nobody typed into. Its
		// own timing is discarded: it is the off arm again, and the off arm is already measured.
		await fs.rm(recording, { force: true });
		await recordFrame(framePty.command, framePty.args, env, FRAME_HOLD_MS, false);

		// Same env, same pty, same binary, and the recording the launch above wrote. Nothing else
		// differs, so the gap between this arm and `first-frame` is the replay and only the replay.
		// A run where they read the same means the recording was rejected: the launch above and this
		// one disagreed about the frame, or the binary changed underneath them.
		//
		// This one types. A first byte is not a usable screen on the replay path either, and the
		// replayed card is bytes from the previous launch rather than a composer that exists yet, so
		// the gap between `replay` and `replay:editable` is how long the screen is a picture. Typing
		// costs this launch its own recording, which nothing reads: the recording is rewritten above
		// on every run.
		const replayed = await recordFrame(framePty.command, framePty.args, env, FRAME_HOLD_MS);
		if (replayed.firstByte !== undefined) push("replay", replayed.firstByte);
		if (replayed.composer !== undefined) push("replay:composer", replayed.composer);
		if (replayed.editable !== undefined) push("replay:editable", replayed.editable);
		if (replayed.statusrow !== undefined) push("replay:statusrow", replayed.statusrow);
	}

	const arms = [
		"version",
		"help",
		"ready:load",
		"ready:boot",
		"ready",
		"first-frame",
		"composer",
		"editable",
		"statusrow",
		"replay",
		"replay:composer",
		"replay:editable",
		"replay:statusrow",
	];
	const lines = [
		`veyyon startup — ${options.bin ? `binary ${options.bin}` : "bun source"}, ${options.cold ? "cold" : "warm"} home, ${options.runs} run(s)`,
		...arms.map(arm =>
			report(
				arm,
				samples.filter(sample => sample.arm === arm).map(sample => sample.ms),
			),
		),
	];
	process.stdout.write(`${lines.join("\n")}\n`);

	if (options.json) {
		await fs.writeFile(
			options.json,
			`${JSON.stringify(
				{
					target: options.bin ?? "bun source",
					home: options.cold ? "cold" : "warm",
					runs: options.runs,
					platform: `${os.platform()}-${os.arch()}`,
					samples,
				},
				null,
				2,
			)}\n`,
		);
	}
}

await main();
