/**
 * Proves that the "Everything as a Plugin" workspace reorganization dropped no CLI command,
 * subcommand, flag, or worker selector, and altered no flag argument-taking shape.
 *
 * WHY THIS SUITE EXISTS. Reorganizing the entire repository into plugins, contracts, and native modules
 * moved ~800 files across packages and touched core CLI entrypoints and dispatch tables. The CLI surface
 * is the primary public interface for users and the internal protocol for subprocess/worker spawning.
 * Dropping a command, altering a flag from value-taking to boolean, or breaking a worker re-entry marker
 * would break runtime behavior silently.
 *
 * WHY THE AST DERIVATION IS USED. The CLI surface is defined across `cli-commands.ts`, `flag-tables.ts`,
 * `profile-bootstrap.ts`, `worker-args.ts`, `launch/protocol.ts`, and `cli.ts`. Instead of executing
 * the CLI or shelling out to git at run time, this suite statically parses the TypeScript AST of those
 * source files in the working tree and compares the derived surface against the committed baseline ledger
 * (`scripts/fixtures/cli-surface.json`) generated from `origin/main`.
 *
 * READING FILE AST IS NOT SOURCE GREP. Reading AST declarations to verify exact contract preservation
 * against a committed differential ledger is structural contract verification, not regex pattern matching on
 * comments or implementation text.
 *
 * WHAT IT DOES NOT CATCH. This suite checks static registration of commands, flags, flag argument shapes,
 * and worker selectors. It does not validate runtime command logic, handler execution, or LLM prompt behavior.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CliSurface, type CliSurfaceLedger, deriveCliSurface, REPO_ROOT } from "./measure-cli-surface";

const LEDGER_PATH = join(REPO_ROOT, "scripts", "fixtures", "cli-surface.json");
const ledger: CliSurfaceLedger = JSON.parse(readFileSync(LEDGER_PATH, "utf-8")) as CliSurfaceLedger;
const currentSurface: CliSurface = deriveCliSurface(REPO_ROOT);

interface SurfaceDiff {
	missingCommands: string[];
	unrecordedCommandAdditions: string[];
	missingFlags: string[];
	flagShapeMismatches: string[];
	unrecordedFlagAdditions: string[];
	missingWorkerSelectors: string[];
	unrecordedWorkerSelectorAdditions: string[];
}

function computeSurfaceDiff(surface: CliSurface, baseline: CliSurfaceLedger): SurfaceDiff {
	const currentCommandSet = new Set(surface.commands);
	const baselineCommandSet = new Set(baseline.commands);
	const recordedCommandAdditions = new Set(baseline.additions.commands);

	const missingCommands = baseline.commands.filter(c => !currentCommandSet.has(c));
	const unrecordedCommandAdditions = surface.commands.filter(
		c => !baselineCommandSet.has(c) && !recordedCommandAdditions.has(c),
	);

	const missingFlags: string[] = [];
	const flagShapeMismatches: string[] = [];
	const unrecordedFlagAdditions: string[] = [];

	for (const [flag, baselineSpec] of Object.entries(baseline.flags)) {
		const currentSpec = surface.flags[flag];
		if (!currentSpec) {
			missingFlags.push(flag);
		} else if (currentSpec.takesValue !== baselineSpec.takesValue) {
			flagShapeMismatches.push(
				`${flag} (expected takesValue=${baselineSpec.takesValue}, got ${currentSpec.takesValue})`,
			);
		}
	}

	for (const flag of Object.keys(surface.flags)) {
		if (!(flag in baseline.flags) && !(flag in baseline.additions.flags)) {
			unrecordedFlagAdditions.push(flag);
		}
	}

	const currentWorkerSet = new Set(surface.workerSelectors);
	const baselineWorkerSet = new Set(baseline.workerSelectors);
	const recordedWorkerAdditions = new Set(baseline.additions.workerSelectors);

	const missingWorkerSelectors = baseline.workerSelectors.filter(w => !currentWorkerSet.has(w));
	const unrecordedWorkerSelectorAdditions = surface.workerSelectors.filter(
		w => !baselineWorkerSet.has(w) && !recordedWorkerAdditions.has(w),
	);

	return {
		missingCommands,
		unrecordedCommandAdditions,
		missingFlags,
		flagShapeMismatches,
		unrecordedFlagAdditions,
		missingWorkerSelectors,
		unrecordedWorkerSelectorAdditions,
	};
}

describe("CLI surface survives the move", () => {
	it("satisfies anti-vacuity floors for commands, flags, and worker selectors", () => {
		// Measured floors based on actual baseline: 38 commands, 60 flags, 9 worker selectors
		expect(currentSurface.commands.length).toBeGreaterThan(30);
		expect(Object.keys(currentSurface.flags).length).toBeGreaterThan(50);
		expect(currentSurface.workerSelectors.length).toBeGreaterThan(5);
	});

	it("preserves every recorded command from origin/main without unrecorded additions", () => {
		const diff = computeSurfaceDiff(currentSurface, ledger);
		expect(diff.missingCommands).toEqual([]);
		expect(diff.unrecordedCommandAdditions).toEqual([]);
		expect(currentSurface.commands).toEqual(ledger.commands);
	});

	it("preserves every recorded flag and its argument shape without unrecorded additions", () => {
		const diff = computeSurfaceDiff(currentSurface, ledger);
		expect(diff.missingFlags).toEqual([]);
		expect(diff.flagShapeMismatches).toEqual([]);
		expect(diff.unrecordedFlagAdditions).toEqual([]);
		expect(currentSurface.flags).toEqual(ledger.flags);
	});

	it("preserves every recorded worker selector from origin/main without unrecorded additions", () => {
		const diff = computeSurfaceDiff(currentSurface, ledger);
		expect(diff.missingWorkerSelectors).toEqual([]);
		expect(diff.unrecordedWorkerSelectorAdditions).toEqual([]);
		expect(currentSurface.workerSelectors).toEqual(ledger.workerSelectors);
	});

	it("pins additions by exact equality against the ledger additions specification", () => {
		const baseCommandSet = new Set(ledger.commands);
		const actualAddedCommands = currentSurface.commands.filter(c => !baseCommandSet.has(c));

		const actualAddedFlags: Record<string, { takesValue: boolean }> = {};
		for (const [flag, spec] of Object.entries(currentSurface.flags)) {
			if (!(flag in ledger.flags)) {
				actualAddedFlags[flag] = spec;
			}
		}

		const baseWorkerSet = new Set(ledger.workerSelectors);
		const actualAddedWorkers = currentSurface.workerSelectors.filter(w => !baseWorkerSet.has(w));

		expect(actualAddedCommands).toEqual(ledger.additions.commands);
		expect(actualAddedFlags).toEqual(ledger.additions.flags);
		expect(actualAddedWorkers).toEqual(ledger.additions.workerSelectors);
	});

	describe("positive controls: comparisons fail on synthetic mutations", () => {
		it("detects a dropped command in an in-memory copy", () => {
			const mutated: CliSurface = {
				...currentSurface,
				commands: currentSurface.commands.filter(c => c !== "config"),
			};
			const diff = computeSurfaceDiff(mutated, ledger);
			expect(diff.missingCommands).toEqual(["config"]);
		});

		it("detects an unrecorded command addition in an in-memory copy", () => {
			const mutated: CliSurface = {
				...currentSurface,
				commands: [...currentSurface.commands, "synthetic-extra-command"].sort(),
			};
			const diff = computeSurfaceDiff(mutated, ledger);
			expect(diff.unrecordedCommandAdditions).toEqual(["synthetic-extra-command"]);
		});

		it("detects a dropped flag in an in-memory copy", () => {
			const mutatedFlags = { ...currentSurface.flags };
			delete mutatedFlags["--model"];
			const mutated: CliSurface = {
				...currentSurface,
				flags: mutatedFlags,
			};
			const diff = computeSurfaceDiff(mutated, ledger);
			expect(diff.missingFlags).toEqual(["--model"]);
		});

		it("detects a flag argument shape mutation in an in-memory copy", () => {
			const mutatedFlags = { ...currentSurface.flags };
			mutatedFlags["--model"] = { takesValue: false }; // Was true
			const mutated: CliSurface = {
				...currentSurface,
				flags: mutatedFlags,
			};
			const diff = computeSurfaceDiff(mutated, ledger);
			expect(diff.flagShapeMismatches).toEqual(["--model (expected takesValue=true, got false)"]);
		});

		it("detects an unrecorded flag addition in an in-memory copy", () => {
			const mutatedFlags = {
				...currentSurface.flags,
				"--synthetic-new-flag": { takesValue: true },
			};
			const mutated: CliSurface = {
				...currentSurface,
				flags: mutatedFlags,
			};
			const diff = computeSurfaceDiff(mutated, ledger);
			expect(diff.unrecordedFlagAdditions).toEqual(["--synthetic-new-flag"]);
		});

		it("detects a dropped worker selector in an in-memory copy", () => {
			const mutated: CliSurface = {
				...currentSurface,
				workerSelectors: currentSurface.workerSelectors.filter(w => w !== "__veyyon_worker_daemon_broker"),
			};
			const diff = computeSurfaceDiff(mutated, ledger);
			expect(diff.missingWorkerSelectors).toEqual(["__veyyon_worker_daemon_broker"]);
		});
	});
});
