/**
 * WHY: When auth gateway is unreachable, every trial in a run fails to reach the provider
 * and produces false 0-scores. `backend.ts` fails closed in preflight, but `runner.ts` previously
 * printed a yellow warning and continued anyway.
 *
 * This suite proves that `runner.ts` refuses the run when the gateway health check fails,
 * while honoring the explicit `--no-gateway` escape hatch flag for offline / direct-key runs.
 */

import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../../src/backends/harbor/runner/cli";
import { gatewayHealthOk } from "../../../src/backends/harbor/runner/gateway";

describe("a failed gateway healthcheck refuses the runner", () => {
	it("reports gatewayHealthOk as false for an unreachable local port", () => {
		// Port 59999 is unbound on loopback
		expect(gatewayHealthOk("http://127.0.0.1:59999")).toBe(false);
	});

	it("parses --no-gateway to disable the gateway check entirely", () => {
		const cfg = parseArgs([
			"--dataset",
			"terminal-bench@3.0",
			"--model",
			"anthropic/claude-3-7-sonnet",
			"--no-gateway",
		]);
		expect(cfg.gateway).toBe(false);
	});

	it("defaults gateway to true so runs fail closed if unconfigured", () => {
		const cfg = parseArgs(["--dataset", "terminal-bench@3.0", "--model", "anthropic/claude-3-7-sonnet"]);
		expect(cfg.gateway).toBe(true);
	});
});
