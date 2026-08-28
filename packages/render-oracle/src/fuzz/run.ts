import { ProcessTerminal } from "@veyyon/tui/terminal";
import { TUI } from "@veyyon/tui/tui";
import { setTerminalHeadless } from "@veyyon/utils";
import { StressRenderScheduler } from "../frames/scheduler";
import { VirtualTerminal } from "../terminal/virtual-terminal";
import { MutableLinesComponent } from "./doubles";
import { StressDriver } from "./driver";
import { withPatchedEnv, withPatchedPlatform } from "./env";
import { normalizeLines } from "./expected-frame";
import type { Scenario } from "./types";

export interface StressScenarioSuccess {
	ok: true;
}

export interface StressScenarioFailure {
	ok: false;
	scenario: string;
	seed: string;
	error: string;
	stack?: string;
}

/**
 * Result a {@link runStressScenario} subprocess emits as a single JSON line on
 * stdout. Each scenario runs in its own `bun` subprocess (one scenario per
 * process), so there is no request multiplexing or `id` to correlate.
 */
export type StressScenarioResult = StressScenarioSuccess | StressScenarioFailure;

export async function runStressScenario(scenario: Scenario, options?: { patchEnv?: boolean }): Promise<void> {
	const run = async (): Promise<void> => {
		await withPatchedPlatform(scenario.platform, async () => {
			const driver = new StressDriver(scenario);
			await driver.run();
		});
	};
	if (options?.patchEnv === false) {
		await run();
	} else {
		await withPatchedEnv(scenario.envMode, run);
	}
}

export function restoreOwnProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor === undefined) {
		delete (target as Record<string, unknown>)[key];
		return;
	}
	Object.defineProperty(target, key, descriptor);
}

export async function runNoReflowResizeNotificationRegression(): Promise<void> {
	await withPatchedEnv("ghostty", async () => {
		await withPatchedPlatform("darwin", async () => {
			const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
			const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
			const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
			const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
			const stdinSetEncoding = Object.getOwnPropertyDescriptor(process.stdin, "setEncoding");
			const stdinResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
			const stdinPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
			const stdoutWrite = Object.getOwnPropertyDescriptor(process.stdout, "write");
			const processKill = Object.getOwnPropertyDescriptor(process, "kill");
			const writes: string[] = [];

			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
			Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "setEncoding", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "resume", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "pause", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdout, "write", {
				value: (chunk: string | Uint8Array) => {
					writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
					return true;
				},
				configurable: true,
			});
			Object.defineProperty(process, "kill", { value: () => true, configurable: true });

			// Exercises the real ProcessTerminal stdin/stdout pipeline; opt out of
			// the test-default headless suppression inside the try so the finally
			// below always restores the prior value, even on a start()/render throw.
			let previousHeadless = false;
			const term = new ProcessTerminal();
			const scheduler = new StressRenderScheduler();
			const tui = new TUI(term, true, { renderScheduler: scheduler });
			const initialLines = Array.from({ length: 35 }, (_value, index) => `stream-row-${index}`);
			const component = new MutableLinesComponent(initialLines);
			const drainTarget = { flush: async () => {} } as VirtualTerminal;
			tui.addChild(component);

			try {
				previousHeadless = setTerminalHeadless(false);
				tui.start();
				await scheduler.drain(drainTarget);

				const reportOnlyWriteStart = writes.length;
				process.stdin.emit("data", "\x1b[48;30;100;600;1000t");
				await scheduler.drain(drainTarget);
				if (writes.length !== reportOnlyWriteStart) {
					throw new Error("Unchanged DEC 2048 resize report scheduled a render without a geometry change");
				}

				const streamingWriteStart = writes.length;
				component.setLines([...initialLines, "stream-row-35"]);
				process.stdin.emit("data", "\x1b[48;30;100;600;1000t");
				tui.requestRender();
				await scheduler.drain(drainTarget);

				const emitted = writes.slice(streamingWriteStart).join("");
				if (emitted.includes("\x1b[3J")) {
					throw new Error(
						"Unchanged DEC 2048 report coalesced with streaming content emitted destructive scrollback clear",
					);
				}
			} finally {
				tui.stop();
				restoreOwnProperty(process.stdin, "isTTY", stdinIsTty);
				restoreOwnProperty(process.stdout, "isTTY", stdoutIsTty);
				restoreOwnProperty(process.stdout, "columns", stdoutColumns);
				restoreOwnProperty(process.stdout, "rows", stdoutRows);
				restoreOwnProperty(process.stdin, "setRawMode", stdinSetRawMode);
				restoreOwnProperty(process.stdin, "setEncoding", stdinSetEncoding);
				restoreOwnProperty(process.stdin, "resume", stdinResume);
				restoreOwnProperty(process.stdin, "pause", stdinPause);
				restoreOwnProperty(process.stdout, "write", stdoutWrite);
				restoreOwnProperty(process, "kill", processKill);
				setTerminalHeadless(previousHeadless);
			}
		});
	});
}

export async function runPreexistingScrollbackRegression(): Promise<void> {
	const term = new VirtualTerminal(40, 5, 100);
	const scheduler = new StressRenderScheduler();
	term.write(`${Array.from({ length: 12 }, (_value, index) => `shell-${index}`).join("\r\n")}\r\n`);
	await term.flush();

	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const component = new MutableLinesComponent(["ui-0", "ui-1", "ui-2"]);
	tui.addChild(component);

	try {
		tui.start();
		await scheduler.drain(term);

		const externalRows = normalizeLines(term.getScrollBuffer()).filter(line => line.startsWith("shell-"));
		if (externalRows.length === 0) {
			throw new Error("Test setup failed: preexisting shell scrollback did not survive initial TUI paint");
		}

		const frames = [
			["ui-0", "inserted-0", "ui-1", "ui-2"],
			["ui-0", "inserted-1", "ui-1", "ui-2"],
			["ui-0", "ui-1", "ui-2"],
			["prefix", "ui-0", "ui-1", "ui-2"],
		] as const;

		for (let index = 0; index < frames.length; index++) {
			component.setLines(frames[index]!);
			tui.requestRender();
			await scheduler.drain(term);

			const buffer = normalizeLines(term.getScrollBuffer());
			for (const row of externalRows) {
				if (!buffer.includes(row)) {
					throw new Error(
						`Preexisting shell scrollback was cleared by visible structural mutation\n${JSON.stringify(
							{ mutationIndex: index, missing: row, externalRows, buffer },
							null,
							2,
						)}`,
					);
				}
			}
		}
	} finally {
		tui.stop();
		await term.flush();
	}
}
