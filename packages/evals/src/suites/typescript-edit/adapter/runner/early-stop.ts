/**
 * Early-stop verification polling for TypeScript edit benchmark runs.
 *
 * Checks if target files match the expected fixture after successful mutation
 * tool executions, short-circuiting the remaining agent turn loop.
 */

import { verifyExpectedFileSubset } from "../../verify";
import type { BenchmarkConfig } from "./types";

export interface EarlyStopOptions {
	check: () => Promise<boolean>;
	onMatch: () => void | Promise<void>;
}

export function buildEarlyStop(params: {
	config: BenchmarkConfig;
	cwd: string;
	expectedDir: string;
	files: string[];
	logEvent: (event: unknown) => Promise<void>;
	attempt: number;
	onMatched: () => void;
}): EarlyStopOptions | undefined {
	if (params.config.earlyStopOnMatch === false) return undefined;
	if (params.files.length === 0) return undefined;
	return {
		check: async () => {
			const verification = await verifyExpectedFileSubset(params.expectedDir, params.cwd, params.files);
			return verification.success;
		},
		onMatch: async () => {
			params.onMatched();
			await params.logEvent({ type: "early_stop", attempt: params.attempt, reason: "formatted_match" });
		},
	};
}
