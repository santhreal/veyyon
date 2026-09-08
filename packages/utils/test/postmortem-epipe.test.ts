import { describe, expect, it } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as postmortem from "../src/postmortem";

/**
 * IPC send failures and child-stdin write failures must not terminate the host.
 * Only errors observed on process.stdout/stderr qualify for quiet teardown.
 */
function makeErr(props: { code?: string; syscall?: string; message?: string }): Error {
	const err = new Error(props.message ?? "broken pipe");
	Object.assign(err, { code: props.code, syscall: props.syscall });
	return err;
}

describe("postmortem.isIpcSendEpipe", () => {
	it("matches EPIPE with syscall 'send' (worker IPC send)", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe(true);
	});

	it("does not match EPIPE from a stdin/stdout write (syscall 'write')", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe(false);
	});

	it("does not match a bare EPIPE without a syscall", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE" }))).toBe(false);
	});

	it("does not match a non-EPIPE error even with syscall 'send'", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "ENOENT", syscall: "send" }))).toBe(false);
	});

	it("does not match a plain Error with no code/syscall", () => {
		expect(postmortem.isIpcSendEpipe(new Error("boom"))).toBe(false);
	});

	it("does not match nullish/missing errno-style fields gracefully", () => {
		expect(postmortem.isIpcSendEpipe(makeErr({ code: undefined, syscall: undefined }))).toBe(false);
	});
});

describe("postmortem.isStdioWriteEpipe", () => {
	it("does not mistake an arbitrary child-stdin write for our stdout/stderr", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe(false);
	});

	it("does not match EPIPE from an IPC send", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe(false);
	});

	it("does not match a bare EPIPE without a syscall", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EPIPE" }))).toBe(false);
	});

	it("does not match a non-EPIPE write error", () => {
		expect(postmortem.isStdioWriteEpipe(makeErr({ code: "EIO", syscall: "write" }))).toBe(false);
	});
});

const modulePath = fileURLToPath(new URL("../src/postmortem.ts", import.meta.url));
const prelude = `import { register } from ${JSON.stringify(modulePath)};`;
const terminalPath = fileURLToPath(new URL("../../tui/src/terminal.ts", import.meta.url));

describe("global EPIPE routing", () => {
	for (const secondEvent of ["error", "uncaughtException", "unhandledRejection"]) {
		it(`finishes TUI persistence before exit after a second ${secondEvent}`, () => {
			const result = spawnSync(
				process.execPath,
				[
					"-e",
					`${prelude}
					import { EventEmitter } from "node:events";
					import { setImmediate } from "node:timers/promises";
					import { ProcessTerminal, emergencyTerminalRestore } from ${JSON.stringify(terminalPath)};
					const exit = process.exit.bind(process);
					let persisted = false;
					let brokenWrites = 0;
					const fake = new EventEmitter();
					fake.broken = false;
					const pipeError = () => Object.assign(new Error("closed TUI output"), { code: "EPIPE", syscall: "write" });
					fake.write = () => {
						if (!fake.broken) return true;
						brokenWrites++;
						const err = pipeError();
						process.stdout.emit("error", err);
						throw err;
					};
					process.stdout.write = fake.write;
					Object.defineProperty(process.stdout, "isTTY", { value: true });
					process.exit = code => {
						process.stderr.write(JSON.stringify({ code, persisted, brokenWrites }));
						exit(persisted && brokenWrites === 0 && code === 0 ? 0 : 91);
					};
					register("session-persistence", async () => {
						const err = pipeError();
						process.stdout.emit("error", err);
						${secondEvent === "error" ? 'process.stdout.emit("error", pipeError());' : `process.emit(${JSON.stringify(secondEvent)}, err);`}
						await setImmediate();
						persisted = true;
					});
					const terminal = new ProcessTerminal();
					terminal.start(() => {}, () => {});
					fake.broken = true;
					process.stdout.emit("error", pipeError());
					// Also cover the blind restore after stop() released the active instance.
					emergencyTerminalRestore();
					`,
				],
				{ encoding: "utf8", timeout: 5000 },
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stderr).toContain('"persisted":true,"brokenWrites":0');
		});
	}

	for (const event of ["uncaughtException", "unhandledRejection"]) {
		for (const plain of [false, true]) {
			it(`continues after child stdin ${event} (${plain ? "plain object" : "Error"})`, () => {
				const result = spawnSync(
					process.execPath,
					[
						"-e",
						`${prelude}
					const err = Object.assign(${plain ? "{}" : 'new Error("broken child stdin")'}, { code: "EPIPE", syscall: "write" });
					register("must-not-clean-up", () => process.stderr.write("CLEANUP"));
					process.emit(${JSON.stringify(event)}, err);
					setImmediate(() => { process.stderr.write("SURVIVED"); process.exit(23); });
				`,
					],
					{ encoding: "utf8", timeout: 5000 },
				);
				expect(result.error).toBeUndefined();
				expect(result.status).toBe(23);
				expect(result.stderr).toContain("SURVIVED");
			});
		}
	}

	for (const output of ["stdout", "stderr"] as const) {
		it(`exits zero when a real ${output} consumer closes its pipe`, async () => {
			const child = spawn(
				process.execPath,
				[
					"-e",
					`${prelude}
				register("proof", reason => process.${output === "stdout" ? "stderr" : "stdout"}.write("CLEANUP:" + reason));
				process.stdin.once("data", () => process.${output}.write("broken pipe"));
			`,
				],
				{ stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
			);
			let evidence = "";
			const survivingOutput = output === "stdout" ? child.stderr : child.stdout;
			survivingOutput.setEncoding("utf8").on("data", chunk => {
				evidence += chunk;
			});
			const closed = Promise.withResolvers<number | null>();
			child.once("error", closed.reject);
			child.once("close", closed.resolve);
			child[output].destroy();
			child.stdin.write("write now");
			expect(await closed.promise).toBe(0);
			expect(evidence).toContain("CLEANUP:exit");
		});
	}
});
