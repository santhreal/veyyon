import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Tool as AiTool } from "@veyyon/ai";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import * as evalBackends from "@veyyon/coding-agent/tools/eval-backends";
import { RuntimeTool } from "@veyyon/coding-agent/tools/runtime";
import { makeToolSession } from "../helpers/tool-session";

function makeSession(opts: {
	launchEnabled?: boolean;
	backends?: Partial<Record<SettingPath, boolean>>;
	spawns?: string | null;
}): ToolSession {
	const settings = Settings.isolated();
	if (opts.launchEnabled !== undefined) {
		settings.set("launch.enabled", opts.launchEnabled);
	}
	for (const [key, value] of Object.entries(opts.backends ?? {})) {
		settings.set(key as SettingPath, value);
	}
	return makeToolSession({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
		settings,
	});
}

function extractWireOps(tool: RuntimeTool): string[] {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		anyOf?: Array<{ properties?: { op?: { const?: string; enum?: string[] } } }>;
		oneOf?: Array<{ properties?: { op?: { const?: string; enum?: string[] } } }>;
		properties?: { op?: { const?: string; enum?: string[] } };
	};
	const variants = wire.anyOf ?? wire.oneOf;
	if (variants) {
		const ops: string[] = [];
		for (const v of variants) {
			const op = v.properties?.op;
			if (op?.const) ops.push(op.const);
			else if (op?.enum) ops.push(...op.enum);
		}
		return ops;
	}
	const op = wire.properties?.op;
	if (op?.const) return [op.const];
	if (op?.enum) return [...op.enum];
	return [];
}

describe("RuntimeTool", () => {
	beforeEach(() => {
		vi.spyOn(evalBackends, "resolveEvalBackends").mockImplementation(evalBackends.readEvalBackendsAllowance);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("eval-only mode", () => {
		it("advertises only exec operation when launch is disabled", () => {
			const session = makeSession({ launchEnabled: false });
			const tool = new RuntimeTool(session);
			const ops = extractWireOps(tool);
			expect(ops).toEqual(["exec"]);
			expect(tool.description).toContain("Kernel Evaluation");
			expect(tool.description).not.toContain("Process Supervision");
			expect(tool.summary).toContain("eval backend");
			expect(tool.examples.every(ex => "call" in ex && ex.call.op === "exec")).toBe(true);
		});

		it("rejects launch operations during execution when launch is disabled", async () => {
			const session = makeSession({ launchEnabled: false });
			const tool = new RuntimeTool(session);
			await expect(
				tool.execute("call_1", { op: "start", name: "test", application: "echo" }),
			).rejects.toThrow(/Process supervision \(start\) is disabled/);
		});
	});

	describe("launch-only mode", () => {
		it("advertises only launch operations when all eval backends are disabled", () => {
			const session = makeSession({
				launchEnabled: true,
				backends: {
					"eval.py": false,
					"eval.js": false,
					"eval.rb": false,
					"eval.jl": false,
				},
			});
			const tool = new RuntimeTool(session);
			const ops = extractWireOps(tool);
			expect(ops).not.toContain("exec");
			expect(ops).toContain("start");
			expect(ops).toContain("logs");
			expect(tool.description).toContain("Process Supervision");
			expect(tool.description).not.toContain("Kernel Evaluation");
			expect(tool.summary).toContain("Supervise a shared project process");
			expect(tool.examples.every(ex => "call" in ex && ex.call.op !== "exec")).toBe(true);
		});

		it("rejects exec operation during execution when eval is disabled", async () => {
			const session = makeSession({
				launchEnabled: true,
				backends: {
					"eval.py": false,
					"eval.js": false,
					"eval.rb": false,
					"eval.jl": false,
				},
			});
			const tool = new RuntimeTool(session);
			await expect(
				tool.execute("call_1", { op: "exec", language: "py", code: "print(1)" }),
			).rejects.toThrow(/Kernel execution \(exec\) is disabled/);
		});
	});

	describe("neither mode", () => {
		it("advertises disabled schema and rejects both exec and launch", async () => {
			const session = makeSession({
				launchEnabled: false,
				backends: {
					"eval.py": false,
					"eval.js": false,
					"eval.rb": false,
					"eval.jl": false,
				},
			});
			const tool = new RuntimeTool(session);
			const ops = extractWireOps(tool);
			expect(ops).toEqual(["disabled"]);
			expect(tool.examples.length).toBe(0);

			await expect(
				tool.execute("call_1", { op: "exec", language: "py", code: "print(1)" }),
			).rejects.toThrow(/Kernel execution \(exec\) is disabled/);

			await expect(
				tool.execute("call_2", { op: "start", name: "test", application: "echo" }),
			).rejects.toThrow(/Process supervision \(start\) is disabled/);
		});
	});

	describe("default / both mode", () => {
		it("advertises both exec and launch ops, honoring approvals and concurrency", () => {
			const session = makeSession({ launchEnabled: true });
			const tool = new RuntimeTool(session);
			const ops = extractWireOps(tool);
			expect(ops).toContain("exec");
			expect(ops).toContain("start");
			expect(ops).toContain("logs");
			expect(ops).toContain("list");
			expect(ops).toContain("wait");
			expect(ops).toContain("send");
			expect(ops).toContain("stop");
			expect(ops).toContain("restart");
			expect(ops).toContain("describe");

			// Approvals
			expect(tool.approval({ op: "list" })).toBe("read");
			expect(tool.approval({ op: "logs" })).toBe("read");
			expect(tool.approval({ op: "wait" })).toBe("read");
			expect(tool.approval({ op: "describe" })).toBe("read");
			expect(tool.approval({ op: "start" })).toBe("exec");
			expect(tool.approval({ op: "exec" })).toBe("exec");
			expect(tool.approval({ op: "send" })).toBe("exec");
			expect(tool.approval({ op: "stop" })).toBe("exec");
			expect(tool.approval({ op: "restart" })).toBe("exec");

			// Concurrency
			expect(tool.concurrency({ op: "exec" })).toBe("exclusive");
			expect(tool.concurrency({ op: "start" })).toBe("shared");
			expect(tool.concurrency({ op: "logs" })).toBe("shared");

			// Intent
			expect(tool.intent({ op: "exec", title: "my step" })).toBe("my step");
			expect(tool.intent({ op: "start", name: "my-server" })).toBe("launch start my-server");
		});

		it("requires language and code on exec and enforces enabled language subset", async () => {
			const session = makeSession({ launchEnabled: true, backends: { "eval.rb": false } });
			const tool = new RuntimeTool(session);

			await expect(
				tool.execute("call_1", { op: "exec", code: "print(1)" } as unknown as { op: "exec"; language: "py"; code: string }),
			).rejects.toThrow(/exec requires language/);

			await expect(
				tool.execute("call_2", { op: "exec", language: "rb" as "py", code: "puts 1" }),
			).rejects.toThrow(/Language "rb" is not enabled/);

			await expect(
				tool.execute("call_3", { op: "exec", language: "py" } as unknown as { op: "exec"; language: "py"; code: string }),
			).rejects.toThrow(/exec requires code/);
		});
	});

	describe("loading policy & prompt rendering", () => {
		it("default off keeps eval and launch loaded and omits runtime", async () => {
			const session = makeToolSession({
				settings: Settings.isolated({ "tools.unifiedRuntime": false }),
			});
			const tools = await createTools(session);
			const names = tools.map(t => t.name);
			expect(names).toContain("eval");
			expect(names).toContain("launch");
			expect(names).not.toContain("runtime");
		});

		it("unifiedRuntime on replaces eval and launch with runtime and renders prompt", async () => {
			const session = makeToolSession({
				settings: Settings.isolated({ "tools.unifiedRuntime": true }),
			});
			const tools = await createTools(session);
			const names = tools.map(t => t.name);
			expect(names).toContain("runtime");
			expect(names).not.toContain("eval");
			expect(names).not.toContain("launch");

			const runtimeTool = tools.find(t => t.name === "runtime");
			expect(runtimeTool).toBeDefined();
			expect(runtimeTool?.description).toContain("Execute persistent code evaluation cells or supervise long-running background processes");
			expect(runtimeTool?.description).toContain("Kernel Evaluation");
			expect(runtimeTool?.description).toContain("Process Supervision");
		});
	});
});
