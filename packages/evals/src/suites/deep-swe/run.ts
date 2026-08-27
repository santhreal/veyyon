#!/usr/bin/env bun
import { errorMessage } from "@veyyon/utils";
import { resolveExitCode } from "./runner/errors";
import { runBench } from "./runner/executor";

/**
 * DeepSWE feature bench for veyyon.
 *
 * Runs the veyyon agent on DeepSWE tasks (datacurve-ai/deep-swe, Harbor task
 * format, executed by Pier) under one or more config ARMS or system adapters,
 * and writes a comparison table of verifier reward + cost/performance metrics per arm.
 */

export * from "./runner";

if (import.meta.main) {
	try {
		const comparison = await runBench(process.argv.slice(2));
		// A comparison that did not pass is a graded outcome, not an error: the report is written
		// either way, and only the exit code separates them.
		if (comparison && comparison.overall !== "pass") process.exitCode = 1;
	} catch (err) {
		console.error(errorMessage(err));
		process.exit(resolveExitCode(err));
	}
}
