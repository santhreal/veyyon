/**
 * WHY: the Landlock launcher scoped files only. A trial's agent could signal every process the
 * runner's user owns, the runner and the trials beside it included, and connect to every abstract
 * Unix socket on the host, among them an X server's, through which it types into the desktop. On a
 * kernel with Landlock ABI 6 or later the launcher now scopes signals and abstract sockets to the
 * trial.
 *
 * The case runs the real backend with a harness whose command is a probe instead of an agent. The
 * probe signals a process the test started outside the trial and connects to an abstract socket the
 * test listens on, then does both to a process and a socket of its own, so a sandbox that refused
 * every signal or every Unix socket (which would stop the launcher ending the agent, and Chrome
 * starting) fails too. The process outside must still be running afterwards.
 *
 * Not caught: pathname Unix sockets, which Landlock does not govern (the session bus, the Docker
 * daemon); `docs/backends.md` states that limit. Without Landlock ABI 6 the case skips.
 */
import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { LocalCliBackend, localTrialLayout } from "../../../backends/local-cli/main";
import { landlockSandbox } from "../../../backends/local-cli/sandbox";
import { oneTrialRun, probeHarness } from "./probe-fixtures";

/** Connects to the abstract socket `argv[1]`, first listening on it when `argv[2]` is `own`. */
const CONNECT = `import errno, socket, sys
name = "\\0" + sys.argv[1]
if sys.argv[2] == "own":
    server = socket.socket(socket.AF_UNIX)
    server.bind(name)
    server.listen(1)
client = socket.socket(socket.AF_UNIX)
try:
    client.connect(name)
    print("ok")
except OSError as error:
    print(errno.errorcode[error.errno])
`;

/** Listens on the abstract socket `argv[1]` until its stdin closes. */
const LISTEN = `import socket, sys
server = socket.socket(socket.AF_UNIX)
server.bind("\\0" + sys.argv[1])
server.listen(8)
print("ready", flush=True)
sys.stdin.read()
`;

/** Signals `outside` and connects to `socketName`, then the same to its own; records each outcome and answers. */
function probe(outside: number, socketName: string): string {
	return `import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
const outcome = run => { try { run(); return "ok"; } catch (error) { return error.code ?? String(error); } };
const connect = (name, whose) =>
	spawnSync("python3", [path.join(import.meta.dirname, "connect.py"), name, whose], { encoding: "utf8" }).stdout.trim();
const own = spawn("sleep", ["600"], { stdio: "ignore" });
fs.writeFileSync("scoped.json", JSON.stringify({
	signalOutside: outcome(() => process.kill(${outside}, "SIGTERM")),
	signalOwn: outcome(() => process.kill(own.pid, "SIGTERM")),
	socketOutside: connect(${JSON.stringify(socketName)}, "outside"),
	socketOwn: connect(${JSON.stringify(`${socketName}-own`)}, "own"),
}));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } } }));
`;
}

/** Whether `pid` is a live process. A zombie waiting on its reaper has already died. */
function running(pid: number): boolean {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return false;
	}
	const state = stat.charAt(stat.lastIndexOf(")") + 2);
	return state !== "Z" && state !== "X";
}

/** Resolves once `child` prints `ready`, or rejects when it exits first. */
async function ready(child: ChildProcess): Promise<void> {
	const started = Promise.withResolvers<void>();
	child.stdout?.on("data", (chunk: Buffer) => {
		if (chunk.toString().includes("ready")) started.resolve();
	});
	child.on("close", code => started.reject(new Error(`the listener exited with ${code} before it was ready`)));
	await started.promise;
}

const sandbox = landlockSandbox();

describe("a sandboxed local trial", () => {
	it.skipIf(!(sandbox.usable && sandbox.abi >= 6))(
		"signals and connects to its own processes and sockets, and to none outside it",
		async () => {
			await using dir = await TempDir.create("@evals-local-cli-scope-");
			const tree = dir.join("tree");
			await fs.mkdir(tree, { recursive: true });
			const socketName = `veyyon-evals-scope-${process.pid}-${path.basename(dir.path())}`;
			const outside = spawn("sleep", ["600"], { stdio: "ignore" });
			const listener = spawn(sandbox.python ?? "python3", ["-c", LISTEN, socketName], {
				stdio: ["pipe", "pipe", "ignore"],
			});
			try {
				await ready(listener);
				const outsidePid = outside.pid ?? 0;
				expect(outsidePid).toBeGreaterThan(0);
				await fs.writeFile(path.join(tree, "connect.py"), CONNECT);
				await fs.writeFile(path.join(tree, "agent.ts"), probe(outsidePid, socketName));
				const { context, cell } = oneTrialRun({
					root: dir.path(),
					suite: "scope-probe",
					harness: probeHarness(tree, "agent.ts"),
					build: tree,
				});
				const layout = localTrialLayout(context.runsDir, context.runId, cell);

				const artifacts = await new LocalCliBackend().runTrial(cell, context);

				expect(artifacts.extra?.exitCode).toBe(0);
				const scoped = JSON.parse(
					await fs.readFile(path.join(layout.trialDir, "workspace", "scoped.json"), "utf8"),
				);
				expect(scoped).toEqual({
					signalOutside: "EPERM",
					signalOwn: "ok",
					socketOutside: "EPERM",
					socketOwn: "ok",
				});
				expect(running(outsidePid)).toBe(true);
			} finally {
				outside.kill("SIGKILL");
				listener.kill("SIGKILL");
			}
		},
	);
});
