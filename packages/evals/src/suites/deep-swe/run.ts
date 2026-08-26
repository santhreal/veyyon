#!/usr/bin/env bun
import { errorMessage } from "@veyyon/utils";
import { resolveExitCode } from "./src/runner/errors";
import { runBench } from "./src/runner/executor";

/**
 * DeepSWE feature bench for veyyon.
 *
 * Runs the veyyon agent on DeepSWE tasks (datacurve-ai/deep-swe, Harbor task
 * format, executed by Pier) under one or more config ARMS or system adapters,
 * and writes a comparison table of verifier reward + cost/performance metrics per arm.
 */

export * from "./src/runner";

if (import.meta.main) {
	try {
		await runBench(process.argv.slice(2));
	} catch (err) {
		console.error(errorMessage(err));
		process.exit(resolveExitCode(err));
	}
}
