import assert from "node:assert/strict";
import * as os from "node:os";
import { postmortem } from "@veyyon/utils";
import { Settings } from "../../src/config/settings";
import { createKernelExecutionDriver } from "../../src/eval/executor-base";
import { disposeAllVmContexts, executeInVmContext, type JsDisplayOutput } from "../../src/eval/js/context-manager";
import type { ToolSession } from "../../src/tools";

// Only the external interpreter is substituted. Its pool and shutdown registration are real.
const kernel = {
	alive: true,
	isAlive() {
		return this.alive;
	},
	async execute() {
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false } as const;
	},
	async shutdown() {
		this.alive = false;
		return { confirmed: true };
	},
};
const driver = createKernelExecutionDriver({
	languageName: "Fixture",
	logLabel: "fixture",
	runIdPrefix: "fixture",
	disposerName: "fixture-kernels",
	startKernel: async () => kernel,
	checkKernelAvailability: async () => ({ ok: true }),
	resolveInterpreterPath: interpreter => interpreter,
});
const cwd = os.tmpdir();
const session: ToolSession = {
	cwd,
	hasUI: false,
	settings: Settings.isolated({}),
	getSessionFile: () => null,
	getSessionSpawns: () => null,
};
const displayed: JsDisplayOutput[] = [];
const options = {
	cwd,
	session,
	sessionKey: "exit-cleanup",
	sessionId: "exit-cleanup",
	ownerId: "exit-owner",
	filename: "exit-cleanup.js",
	runState: { onDisplay: (output: JsDisplayOutput) => displayed.push(output) },
};
await driver.pool.acquireSession("fixture-session", "fixture-session", cwd, { kernelOwnerId: "fixture-owner" });
try {
	await executeInVmContext({
		...options,
		code: "globalThis.cleanupProbe = 73; display({ probe: globalThis.cleanupProbe });",
	});
	assert.deepEqual(displayed, [{ type: "json", data: { probe: 73 } }]);
	assert.equal(kernel.isAlive(), true);
	await postmortem.cleanup();
	assert.equal(kernel.isAlive(), false, "process cleanup left a kernel alive");
	assert.equal(driver.pool.sessions.size, 0);
	displayed.length = 0;
	await executeInVmContext({ ...options, code: "display({ probe: typeof globalThis.cleanupProbe });" });
	assert.deepEqual(
		displayed,
		[{ type: "json", data: { probe: "undefined" } }],
		"process cleanup retained the JS evaluator context",
	);
	process.stdout.write(`${JSON.stringify({ kernelReleased: true, jsContextReleased: true })}\n`);
} finally {
	await driver.disposeAll();
	await disposeAllVmContexts();
}
