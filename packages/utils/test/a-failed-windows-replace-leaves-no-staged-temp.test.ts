/**
 * WHY: on Windows a rename over an existing file can fail, and every writer then moves the target
 * aside, installs the staged temp, and moves the target back when the install fails. The blocking
 * writer ran that fallback inline and left its staged `.tmp` beside the target on four failure
 * branches (a target refused mid-replace, a failed backup move, a failed reinstall after the target
 * vanished, a failed restore), where the async writers removed it.
 *
 * Class closed: for every exported `atomicWrite*` writer and every combination of outcomes at the
 * fallback's backup move, reinstall, restore and backup cleanup, no staged temp survives, the
 * original bytes stay at the target or in the one `.previous` backup, the failure thrown is an
 * injected one, and a call that resolves leaves the new bytes and no backup. A new writer export
 * fails the sweep until it has a driver here.
 *
 * Not caught: real Windows rename semantics (the platform reads as win32 and the renames are
 * injected on the host filesystem), and a process killed partway through the fallback.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as atomicWrite from "../src/atomic-write";
import { TempDir } from "../src/temp";

const ORIGINAL = "ORIGINAL-BYTES";
const NEW = "NEW-BYTES";

interface Driver {
	sync: boolean;
	write(target: string): Promise<void> | void;
	/** What the target holds after a successful write. */
	written: string;
}

const DRIVERS: Record<string, Driver> = {
	atomicWriteFile: { sync: false, write: target => atomicWrite.atomicWriteFile(target, NEW), written: NEW },
	atomicWriteFilePreservingMode: {
		sync: false,
		write: target => atomicWrite.atomicWriteFilePreservingMode(target, NEW),
		written: NEW,
	},
	atomicWriteJson: {
		sync: false,
		write: target => atomicWrite.atomicWriteJson(target, NEW),
		written: `${JSON.stringify(NEW)}\n`,
	},
	atomicWriteFileWith: {
		sync: false,
		write: target => atomicWrite.atomicWriteFileWith(target, tempPath => fsp.writeFile(tempPath, NEW)),
		written: NEW,
	},
	atomicWriteFileSync: { sync: true, write: target => atomicWrite.atomicWriteFileSync(target, NEW), written: NEW },
};

/** What one step of the fallback does: proceed, or fail with that code. */
type Outcome = "ok" | "ENOENT" | "EBUSY" | "EIO";

interface Plan {
	/** Moving the target aside. ENOENT reads as another writer having removed it. */
	backup: Outcome;
	/** Installing the staged temp after the target moved aside. */
	reinstall: Outcome;
	/** Moving the target back after a failed reinstall. */
	restore: Outcome;
	/** Removing the moved-aside target after a successful reinstall. */
	cleanup: Outcome;
}

const STEP_OUTCOMES: { [Step in keyof Plan]: readonly Outcome[] } = {
	backup: ["ok", "ENOENT", "EBUSY"],
	reinstall: ["ok", "EIO"],
	restore: ["ok", "EIO"],
	cleanup: ["ok", "EBUSY"],
};

/** The failure codes a plan injects; ENOENT on the backup move is part of the fallback, not a failure. */
const INJECTED_FAILURES = ["EBUSY", "EIO"];

function everyPlan(): Plan[] {
	let plans: Partial<Plan>[] = [{}];
	for (const [step, outcomes] of Object.entries(STEP_OUTCOMES)) {
		plans = plans.flatMap(plan => outcomes.map(outcome => ({ ...plan, [step]: outcome })));
	}
	return plans as Plan[];
}

function fault(code: string): Error {
	return Object.assign(new Error(`${code}: injected`), { code });
}

function failureFor(outcome: Outcome): Error | undefined {
	return outcome === "ok" ? undefined : fault(outcome);
}

/** The error a rename of `oldPath` to `newPath` throws under `plan`, or undefined to run it. */
function renameFaults(plan: Plan, target: string): (oldPath: string, newPath: string) => Error | undefined {
	let installs = 0;
	return (oldPath, newPath) => {
		if (newPath === target && oldPath.includes(".previous.")) return failureFor(plan.restore);
		// The first install fails the way Windows refuses a replace, which starts the fallback.
		if (newPath === target) return ++installs === 1 ? fault("EEXIST") : failureFor(plan.reinstall);
		if (oldPath === target && newPath.includes(".previous.")) return failureFor(plan.backup);
		return undefined;
	};
}

/** Installs the plan's faults on the writer's filesystem calls; returns the undo. */
function injectFaults(sync: boolean, plan: Plan, target: string): () => void {
	const renameFault = renameFaults(plan, target);
	const cleanupFault = (entry: unknown): Error | undefined =>
		String(entry).includes(".previous.") ? failureFor(plan.cleanup) : undefined;
	if (sync) {
		const realRename = fs.renameSync;
		const realRm = fs.rmSync;
		const rename = spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
			const error = renameFault(String(oldPath), String(newPath));
			if (error) throw error;
			realRename(oldPath, newPath);
		});
		const rm = spyOn(fs, "rmSync").mockImplementation((entry, options) => {
			const error = cleanupFault(entry);
			if (error) throw error;
			realRm(entry, options);
		});
		return () => {
			rename.mockRestore();
			rm.mockRestore();
		};
	}
	const realRename = fsp.rename;
	const realRm = fsp.rm;
	const rename = spyOn(fsp, "rename").mockImplementation(async (oldPath, newPath) => {
		const error = renameFault(String(oldPath), String(newPath));
		if (error) throw error;
		await realRename(oldPath, newPath);
	});
	const rm = spyOn(fsp, "rm").mockImplementation(async (entry, options) => {
		const error = cleanupFault(entry);
		if (error) throw error;
		await realRm(entry, options);
	});
	return () => {
		rename.mockRestore();
		rm.mockRestore();
	};
}

/** Runs `write` with the platform reading as win32, restoring it afterwards. */
async function asWindows(write: () => Promise<void> | void): Promise<{ resolved: boolean; thrown: unknown }> {
	const platform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	try {
		await write();
		return { resolved: true, thrown: undefined };
	} catch (thrown) {
		return { resolved: false, thrown };
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: platform });
	}
}

/** Every code an error carries, through an AggregateError's members. */
function codesOf(thrown: unknown): string[] {
	if (thrown instanceof AggregateError) return thrown.errors.flatMap(codesOf);
	const code = (thrown as { code?: unknown } | null)?.code;
	return typeof code === "string" ? [code] : [];
}

describe("a failed Windows replace", () => {
	let dir: TempDir;

	beforeEach(async () => {
		dir = await TempDir.create("@veyyon-windows-replace-");
	});

	afterEach(async () => {
		await dir.remove();
	});

	/** The staged temps and the moved-aside backups (by content) left beside `target`. */
	function leftovers(target: string): { staged: string[]; backups: string[] } {
		const base = path.basename(target);
		const names = fs
			.readdirSync(path.dirname(target))
			.filter(name => name.startsWith(`.${base}.`) && name.endsWith(".tmp"));
		const isBackup = (name: string): boolean => name.startsWith(`.${base}.previous.`);
		return {
			staged: names.filter(name => !isBackup(name)),
			backups: names.filter(isBackup).map(name => fs.readFileSync(path.join(path.dirname(target), name), "utf8")),
		};
	}

	it("has a driver for every exported writer", () => {
		const writers = Object.keys(atomicWrite).filter(name => name.startsWith("atomicWrite"));
		expect(writers.sort()).toEqual(Object.keys(DRIVERS).sort());
	});

	for (const [name, driver] of Object.entries(DRIVERS)) {
		for (const plan of everyPlan()) {
			const label = Object.entries(plan)
				.map(([step, outcome]) => `${step}=${outcome}`)
				.join(" ");
			it(`${name} keeps no staged temp and loses no bytes when ${label}`, async () => {
				const target = path.join(dir.path(), "settings.json");
				fs.writeFileSync(target, ORIGINAL);
				const undo = injectFaults(driver.sync, plan, target);
				let outcome: { resolved: boolean; thrown: unknown };
				try {
					outcome = await asWindows(() => driver.write(target));
				} finally {
					undo();
				}

				const { staged, backups } = leftovers(target);
				const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
				expect(staged).toEqual([]);
				expect(backups.filter(backup => backup !== ORIGINAL)).toEqual([]);
				expect(backups.length).toBeLessThanOrEqual(1);
				if (outcome.resolved) {
					expect(content).toBe(driver.written);
					expect(backups).toEqual([]);
					return;
				}
				expect([content, ...backups]).toContain(ORIGINAL);
				const codes = codesOf(outcome.thrown);
				expect(codes.length).toBeGreaterThan(0);
				expect(codes.filter(code => !INJECTED_FAILURES.includes(code))).toEqual([]);
			});
		}

		it(`${name} keeps no staged temp when the target turns into a directory mid-replace`, async () => {
			const target = path.join(dir.path(), "settings.json");
			fs.writeFileSync(target, ORIGINAL);
			const refuseOnce = (): Error => {
				fs.rmSync(target);
				fs.mkdirSync(target);
				return fault("EEXIST");
			};
			let refused = false;
			const realRename = fs.renameSync;
			const realRenameAsync = fsp.rename;
			const rename = driver.sync
				? spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
						if (String(newPath) === target && !refused) {
							refused = true;
							throw refuseOnce();
						}
						realRename(oldPath, newPath);
					})
				: spyOn(fsp, "rename").mockImplementation(async (oldPath, newPath) => {
						if (String(newPath) === target && !refused) {
							refused = true;
							throw refuseOnce();
						}
						await realRenameAsync(oldPath, newPath);
					});
			let outcome: { resolved: boolean; thrown: unknown };
			try {
				outcome = await asWindows(() => driver.write(target));
			} finally {
				rename.mockRestore();
			}

			expect(outcome.resolved).toBe(false);
			expect(String(outcome.thrown)).toContain("it is a directory");
			expect(fs.statSync(target).isDirectory()).toBe(true);
			expect(leftovers(target)).toEqual({ staged: [], backups: [] });
		});
	}
});
