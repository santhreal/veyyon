/**
 * WHY: adopting a child into the session CPU budget after `Bun.spawn` returns
 * cannot un-run it. A saturated session, or one whose budget group could not
 * be created, has to refuse the spawn while the process still does not exist.
 * `cpu-limit.test.ts` proves the limiter refuses; this suite proves the
 * refusal reaches the callers that spawn on the model's behalf, by driving the
 * real extension API and the real Python executor rather than reading their
 * source for the name of a parameter.
 *
 * The class this closes: a spawn path that takes the session gate but never
 * awaits it before creating the process, and a path that resolves the limiter
 * by the wrong key. The eval executors keyed adoption on `options.sessionId`,
 * the namespaced kernel id (`python:<id>`), while the limiter is registered
 * under the tool session id, so the lookup found nothing and the cell ran
 * outside the budget without a word. Both tests here pass a kernel-style
 * `sessionId` that is deliberately not the registered one, so resolving by it
 * again turns them red.
 *
 * What it does not catch: the adopt half of the eval path. `startKernel` only
 * adopts once a kernel is actually starting, which needs a real interpreter,
 * so only the gate half is driven here. `cpu-limit-spawn-sites.test.ts` is
 * what fails when a new file spawns a process and joins neither.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executePython } from "@veyyon/coding-agent/eval/py/executor";
import { ExtensionRuntime, loadExtensionFromFactory } from "@veyyon/coding-agent/extensibility/extensions/loader";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";
import { CpuLimitDeniedError, initSessionCpuLimit, resetSessionCpuLimitsForTests } from "../src/session/cpu-limit";
import { makeCgroupRoot, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

/**
 * A host with no delegated cgroup parent and no systemd: the probe reports
 * unsupported, so a configured budget marks setup failed and every spawn is
 * refused. That is the fail-closed arm the gate exists for.
 */
async function registerUnenforceableBudget(sessionId: string): Promise<void> {
	const root = await makeCgroupRoot();
	await initSessionCpuLimit({
		sessionId,
		cores: 2,
		kill: false,
		onNotice: () => {},
		env: makeFakeHost(root).env,
	});
}

describe("a spawn that cannot join the session budget", () => {
	afterEach(async () => {
		resetSessionCpuLimitsForTests();
		await removeCgroupRoots();
	});

	it("never starts the process an extension's exec asked for", async () => {
		const dir = TempDir.createSync("@pi-cpu-gate-extension-");
		try {
			const marker = path.join(dir.path(), "the-child-ran");
			// A script file, not an `-e` one-liner: `ExecOptions` carries no env, so a probe that
			// resolves veyyon's directories against the inherited environment could write into the
			// developer's real tree on the day the gate regresses and the child does run. This one
			// touches nothing but the marker inside the temp directory.
			const probe = path.join(dir.path(), "probe.js");
			await fs.writeFile(probe, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`);
			let execResult: Promise<unknown> | undefined;
			await loadExtensionFromFactory(
				api => {
					execResult = api.exec(process.execPath, [probe]);
				},
				dir.path(),
				new EventBus(),
				new ExtensionRuntime(),
				"<cpu-gate-test>",
				() => {},
				async what => {
					throw new CpuLimitDeniedError(`Refused to start ${what}: saturated`);
				},
			);

			expect(execResult).toBeDefined();
			await expect(execResult).rejects.toThrow(/Refused to start an extension command/);
			expect(await fs.stat(marker).catch(() => null)).toBeNull();
		} finally {
			dir.removeSync();
		}
	});

	it("refuses a Python eval cell by the tool session id, not the kernel id", async () => {
		await registerUnenforceableBudget("sess-eval-gate");

		await expect(
			executePython("1 + 1", {
				// The kernel id is namespaced and is not what the limiter is keyed
				// by. Resolving the gate from this field finds no limiter and the
				// cell runs uncapped.
				sessionId: "python:sess-eval-gate",
				toolSession: { getSessionId: () => "sess-eval-gate" } as unknown as ToolSession,
			}),
		).rejects.toThrow(/Refused to start a Python eval cell/);
	});
});
