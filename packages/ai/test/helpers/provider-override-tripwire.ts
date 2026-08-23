/**
 * The tripwire that stops one suite's provider stub from answering another suite's request.
 *
 * `setBedrockProviderModule` and its eleven siblings replace a provider for the whole PROCESS, and
 * `bun test` runs a bucket's files in one process. A suite that installs an override and never
 * restores it therefore replaces that provider for every file after it, and the failure lands on the
 * innocent one: `a-credential-handshake-cannot-outlive-the-declared-budget.test.ts` terminated a
 * Bedrock turn in 3ms and reported that it never named a deadline, because it was talking to
 * `issue-4593-repro.test.ts`'s stub instead of a `credential_process` that sleeps. Bisecting 454
 * files to find that took nine runs; this makes the next one report itself immediately.
 *
 * Loaded through `[test] preload`, so nothing opts in and nothing can forget it — the same reason
 * `packages/utils/test/helpers/real-data-tripwire.ts` is a preload rather than a helper.
 *
 * ## What it checks, and why it is not "is anything installed"
 *
 * It snapshots the override set before each test and fails the test that ENDS with an override the
 * test did not inherit: a new api, or a different stub under an api that was already there. Those
 * keys are put back to what the test inherited first, so one leak costs one failure instead of a
 * cascade, and the red lands on the test that leaked, which is the only place the fix belongs.
 *
 * The simpler rule, fail when anything is installed at all, is wrong for a caller that already
 * exists: `packages/simulations/src/turn-sim/harness.ts` replaces all twelve apis at module scope on
 * purpose and holds them for the life of the process. In a process that loads a simulation and an
 * `ai` suite together, every `ai` test inherits those twelve, and each one that restores its own stub
 * with `setCursorProviderModule()` is doing the right thing — under an empty-set rule all 27 of them
 * were red.
 *
 * ## What it does not catch
 *
 * A suite that installs an override and restores it inside the same test is invisible here, which is
 * correct — that is the supported pattern.
 *
 * A test that REMOVES an override it inherited is also invisible, which is the price of the rule
 * above: a restore and a removal are the same call, and the restore is the common one. The exposure
 * is a simulation whose stub is cleared by a neighbour in the same process, which the simulations
 * harness would report as a real provider call rather than a wrong answer.
 *
 * An install at MODULE scope is invisible too, because it is already in the baseline of every test in
 * its file; that install still reaches every later file in the bucket, and the simulations harness is
 * the one place that does it deliberately.
 *
 * It says nothing about the OTHER process-wide seams a suite can leave behind (a custom api
 * registration, a host LLM backend, a fake clock); each needs its own answer to "is anything still
 * installed", and the provider registry is the one that has it.
 */
import { afterEach, beforeEach } from "bun:test";
import {
	type LazyProviderModule,
	providerModuleOverrideSnapshot,
	setProviderModuleOverrideForTest,
} from "@veyyon/ai/providers/register-builtins";
import type { Api } from "@veyyon/ai/types";

let inherited: ReadonlyMap<Api, LazyProviderModule<Api>> = new Map();

beforeEach(() => {
	inherited = providerModuleOverrideSnapshot();
});

afterEach(() => {
	const installed: Api[] = [];
	for (const [api, module] of providerModuleOverrideSnapshot()) {
		if (inherited.get(api) !== module) installed.push(api);
	}
	if (installed.length === 0) return;
	for (const api of installed) setProviderModuleOverrideForTest(api, inherited.get(api));
	throw new Error(
		`This test left a provider module override installed for ${installed.sort().join(", ")}. ` +
			"An override is process-wide, so it answers every later test file in this bucket and the failure " +
			"surfaces there instead of here. Restore it in the test that set it: call the setter with no " +
			"argument in a finally or an afterEach.",
	);
});
