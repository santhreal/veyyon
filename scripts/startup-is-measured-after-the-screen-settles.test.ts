/**
 * WHY: first-byte and raw echo timings accept a provisional launch card as startup.
 * This suite covers rendered-state measurement, late metadata and style changes,
 * edited input, chunked ANSI, and bounded settlement. It does not prove product
 * startup or responsiveness; those require the real PTY benchmark.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Process, ProcessStatus } from "@veyyon/natives";
import { recordSettledStartup } from "./record-settled-startup";
import { StartupFrameObserver } from "./startup-frame-observer";

const observers: StartupFrameObserver[] = [];
const scratchDirectories: string[] = [];
function observer(): StartupFrameObserver {
	const value = new StartupFrameObserver(100, 10, "Study Model", "qjq");
	observers.push(value);
	return value;
}
const frame = (model: string, gauge: string, draft = "qjq"): string =>
	`\x1b[2J\x1b[H${model}\r\n\r\n  › ${draft}\r\n${gauge}`;

afterEach(async () => {
	for (const value of observers.splice(0)) value.dispose();
	for (const directory of scratchDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("settled editable startup", () => {
	test("counts the final metadata update rather than the first editable card", async () => {
		const value = observer();
		await value.write(frame("probe-model", "? left"), 20);
		await value.write(frame("Study Model", "71% left"), 240);
		expect(await value.finish(1500, 1000)).toEqual({
			firstByte: 20,
			editable: 20,
			settledEditable: 240,
			observationMs: 1500,
			stableForMs: 1260,
		});
	});

	test("rejects raw echo outside the composer", async () => {
		const value = observer();
		await value.write(`qjq\r\n${frame("Study Model", "71% left", "ask anything")}\r\nqjq`, 20);
		await expect(value.finish(1500, 1000)).rejects.toThrow("editable composer");
	});

	test("requires metadata to remain present instead of matching discarded output", async () => {
		const value = observer();
		await value.write(frame("Study Model", "71% left"), 20);
		await value.write(frame("probe-model", "? left"), 200);
		await expect(value.finish(1500, 1000)).rejects.toThrow("resolved metadata");
	});

	test("parses ANSI split across chunks and ignores nonvisual control traffic", async () => {
		const value = observer();
		await value.write("\x1b[2", 10);
		await value.write("J\x1b[HStudy Model\r\n\r\n  › qjq\r\n71% left", 30);
		await value.write("\x1b[6n", 800);
		expect((await value.finish(1500, 1000)).settledEditable).toBe(30);
	});

	test("includes a style-only repaint in the settling interval", async () => {
		const value = observer();
		await value.write(frame("Study Model", "71% left"), 20);
		await value.write(`\x1b[31m${frame("Study Model", "71% left")}`, 600);
		expect((await value.finish(1800, 1000)).settledEditable).toBe(600);
	});

	test("rejects an observation ending before the required stable tail", async () => {
		const value = observer();
		await value.write(frame("Study Model", "71% left"), 1100);
		await expect(value.finish(1500, 1000)).rejects.toThrow("require 1000ms");
	});

	test("timestamps edited drafts rather than an unfinished deletion", async () => {
		const value = observer();
		value.noteInput("qjq", 10);
		await value.write(frame("probe-model", "? left", "qjX"), 20);
		await value.write(frame("probe-model", "? left"), 35);
		value.noteInput("qjqx", 40);
		await value.write(frame("Study Model", "71% left", "qjqxY"), 60);
		expect(value.inputProbes[1]?.renderedAt).toBeNull();
		await value.write(frame("Study Model", "71% left", "qjqx"), 90);
		await value.finish(1500, 1000);
		expect(value.inputProbes).toEqual([
			{ draft: "qjq", sentAt: 10, renderedAt: 35, metadataReady: false },
			{ draft: "qjqx", sentAt: 40, renderedAt: 90, metadataReady: true },
		]);
	});

	test("counts coalesced input at the frame that first contains every edited character", async () => {
		const value = observer();
		value.noteInput("qjq", 10);
		value.noteInput("qjqx", 20);
		value.noteInput("qjqxx", 30);
		await value.write(frame("Study Model", "71% left", "qjqxx"), 200);
		await value.finish(1500, 1000);
		expect(value.inputProbes.map(probe => probe.renderedAt! - probe.sentAt)).toEqual([190, 180, 170]);
	});

	test.each(["never rendered", "lost after handoff"])("rejects input %s", async failure => {
		const value = observer();
		value.noteInput("qjq", 10);
		await value.write(frame("Study Model", "71% left"), 20);
		value.noteInput("qjqx", 30);
		if (failure === "lost after handoff") await value.write(frame("Study Model", "71% left", "qjqx"), 40);
		await value.write(frame("Study Model", "71% left"), 100);
		await expect(value.finish(1500, 1000)).rejects.toThrow("render and retain every input probe");
	});

	test.skipIf(process.platform === "win32")(
		"a failed observation ends its child process tree within a bound",
		async () => {
			const root = join(import.meta.dirname, "../.captures");
			await mkdir(root, { recursive: true });
			const directory = await mkdtemp(join(root, "settled-startup-test-"));
			scratchDirectories.push(directory);
			const trace = join(directory, "trace.json");
			const started = performance.now();
			await expect(
				recordSettledStartup({
					command: "/bin/sh",
					args: ["-c", "sleep 10 & printf 'child=%s\\n' \"$!\"; wait"],
					cwd: directory,
					env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
					columns: 100,
					rows: 10,
					expectedModel: "Study Model",
					observationMs: 200,
					stableMs: 100,
					trace,
				}),
			).rejects.toThrow("Settled startup measurement failed");
			expect(performance.now() - started).toBeLessThan(4000);
			const recorded = JSON.parse(await readFile(trace, "utf8")) as { samples: { text: string }[] };
			const match = recorded.samples
				.map(sample => sample.text)
				.join("\n")
				.match(/child=(\d+)/);
			expect(match).not.toBeNull();
			const child = Process.fromPid(Number(match![1]));
			expect(child?.status() ?? ProcessStatus.Exited).toBe(ProcessStatus.Exited);
		},
	);
});
