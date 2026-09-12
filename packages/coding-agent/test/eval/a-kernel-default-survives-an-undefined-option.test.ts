/**
 * Optional kernel configuration must treat undefined as omission. Spreading an
 * undefined codec or exit payload over defaults breaks execution or graceful
 * shutdown. This runs BaseKernel against a real NDJSON peer process; it does not
 * test language interpreters or the exact interrupt-escalation interval. The
 * delayed SIGINT acknowledgement case requires POSIX signal delivery.
 */
import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	assembleSpawnEnv,
	BaseKernel,
	type BaseKernelOptions,
	buildJsonKernelPayload,
	spawnKernelProcess,
} from "@veyyon/coding-agent/eval/kernel-base";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

class ProtocolKernel extends BaseKernel {}

const variants: Array<{
	name: string;
	options: Omit<BaseKernelOptions, "languageName">;
	expectedCode: string;
	expectedGraceful?: boolean;
}> = [
	{ name: "omitted", options: {}, expectedCode: "probe" },
	{
		name: "undefined",
		options: {
			traceIpc: undefined,
			exitPayload: undefined,
			interruptEscalationMs: undefined,
			shutdownGraceMs: undefined,
			buildPayload: undefined,
		},
		expectedCode: "probe",
	},
	{
		name: "custom",
		options: {
			exitPayload: '{"type":"exit","custom":true}',
			shutdownGraceMs: 1000,
			buildPayload: (code, id, options) => buildJsonKernelPayload(`custom:${code}`, id, options),
		},
		expectedCode: "custom:probe",
	},
	{ name: "empty", options: { exitPayload: "" }, expectedCode: "probe" },
	{ name: "no-grace", options: { shutdownGraceMs: 0 }, expectedCode: "probe", expectedGraceful: false },
];

it.each(variants)(
	"executes and honors shutdown with $name options",
	async ({ name, options, expectedCode, expectedGraceful = true }) => {
		const kernel = new ProtocolKernel(name, { languageName: "Protocol", ...options });
		const proc = spawnKernelProcess(
			[process.execPath, fileURLToPath(new URL("../fixtures/kernel-protocol-peer.ts", import.meta.url)), name],
			{ cwd: process.cwd(), env: assembleSpawnEnv(process.env) },
		);
		kernel.setProcess(proc);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Kernel round trip exceeded its deadline")), 2000);
		const started = performance.now();
		let output = "";
		try {
			const result = await kernel.execute("probe", {
				id: "round-trip",
				cwd: "/repo",
				env: { DEMO: "1" },
				signal: controller.signal,
				onChunk: text => {
					output += text;
				},
			});
			expect(result.status).toBe("ok");
			expect(result.cancelled).toBe(false);
			expect(JSON.parse(output)).toEqual({
				id: "round-trip",
				code: expectedCode,
				cwd: "/repo",
				env: { DEMO: "1" },
				silent: false,
				storeHistory: true,
			});
			const shutdown = await kernel.shutdown();
			if (expectedGraceful) {
				expect(shutdown).toEqual({ confirmed: true });
				expect(await proc.exited).toBe(0);
			} else {
				expect(await proc.exited).not.toBe(0);
			}
			expect(performance.now() - started).toBeLessThan(4000);
		} finally {
			clearTimeout(timer);
			await kernel.shutdown({ timeoutMs: 200 });
		}
	},
	5000,
);
it.skipIf(process.platform === "win32").each([
	{ name: "default", interruptEscalationMs: undefined },
	{ name: "zero", interruptEscalationMs: 0 },
])(
	"honors interrupt acknowledgement with $name interval",
	async ({ interruptEscalationMs }) => {
		const kernel = new ProtocolKernel("interrupt", { languageName: "Protocol", interruptEscalationMs });
		const proc = spawnKernelProcess(
			[process.execPath, fileURLToPath(new URL("../fixtures/kernel-protocol-peer.ts", import.meta.url))],
			{ cwd: process.cwd(), env: assembleSpawnEnv(process.env) },
		);
		kernel.setProcess(proc);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		const started = performance.now();
		try {
			const result = await kernel.execute("interrupt", {
				signal: controller.signal,
				onChunk: text => {
					if (text === "ready") controller.abort();
				},
			});
			expect(result.cancelled).toBe(true);
			expect(result.kernelKilled).toBe(interruptEscalationMs === 0);
			expect(performance.now() - started).toBeLessThan(4000);
		} finally {
			clearTimeout(timer);
			await kernel.shutdown({ timeoutMs: 200 });
		}
	},
	5000,
);
