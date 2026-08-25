#!/usr/bin/env bun
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
	await runBench(process.argv.slice(2));
}
