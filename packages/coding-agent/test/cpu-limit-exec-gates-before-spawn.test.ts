/**
 * Custom-tool `exec` must refuse before the process exists.
 *
 * Adopting after spawn still lets a saturated session start work. The
 * contract is: `beforeSpawn` runs first, and a throw there never reaches
 * `ptree.exec`.
 */
import { describe, expect, it } from "bun:test";
import { execCommand, withSessionCpuExec } from "../src/exec/exec";
import { StdioTransport } from "../src/mcp/transports/stdio";

describe("execCommand CPU gate", () => {
	it("runs beforeSpawn before creating the process, and a throw skips the spawn", async () => {
		const order: string[] = [];
		await expect(
			execCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd(), {
				beforeSpawn: async () => {
					order.push("gate");
					throw new Error("session CPU budget saturated");
				},
				adoptPid: () => {
					order.push("adopt");
				},
			}),
		).rejects.toThrow(/saturated/);
		expect(order).toEqual(["gate"]);
	});

	it("adopts after a gate that allows the spawn", async () => {
		const order: string[] = [];
		const result = await execCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd(), {
			beforeSpawn: async () => {
				order.push("gate");
			},
			adoptPid: () => {
				order.push("adopt");
			},
		});
		expect(result.code).toBe(0);
		expect(order[0]).toBe("gate");
		expect(order).toContain("adopt");
	});
});

describe("MCP stdio CPU gate", () => {
	it("runs beforeSpawn before creating the process, and a throw skips the spawn", async () => {
		const order: string[] = [];
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
		} as never);
		transport.beforeSpawn = async () => {
			order.push("gate");
			throw new Error("session CPU budget saturated");
		};
		transport.onSpawnPid = () => {
			order.push("adopt");
		};
		await expect(transport.connect()).rejects.toThrow(/saturated/);
		expect(order).toEqual(["gate"]);
	});

	it("adopts after a gate that allows the spawn", async () => {
		const order: string[] = [];
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
		} as never);
		transport.beforeSpawn = async () => {
			order.push("gate");
		};
		transport.onSpawnPid = () => {
			order.push("adopt");
		};
		await transport.connect();
		try {
			expect(order[0]).toBe("gate");
			expect(order).toContain("adopt");
		} finally {
			await transport.close();
		}
	});
});

describe("withSessionCpuExec composition", () => {
	it("runs the CPU gate before a caller beforeSpawn, and skips both the caller hook and the spawn when the gate throws", async () => {
		const order: string[] = [];
		const options = withSessionCpuExec(
			{
				beforeSpawn: async () => {
					order.push("caller-gate");
				},
				adoptPid: () => {
					order.push("caller-adopt");
				},
			},
			() => {
				order.push("session-adopt");
			},
			async () => {
				order.push("session-gate");
				throw new Error("session CPU budget saturated");
			},
			"a custom tool",
		);
		await expect(execCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd(), options)).rejects.toThrow(
			/saturated/,
		);
		expect(order).toEqual(["session-gate"]);
	});

	it("runs session then caller hooks when the gate allows the spawn", async () => {
		const order: string[] = [];
		const options = withSessionCpuExec(
			{
				beforeSpawn: async () => {
					order.push("caller-gate");
				},
				adoptPid: () => {
					order.push("caller-adopt");
				},
			},
			() => {
				order.push("session-adopt");
			},
			async () => {
				order.push("session-gate");
			},
			"a custom tool",
		);
		const result = await execCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd(), options);
		expect(result.code).toBe(0);
		expect(order[0]).toBe("session-gate");
		expect(order[1]).toBe("caller-gate");
		expect(order).toContain("session-adopt");
		expect(order).toContain("caller-adopt");
		expect(order.indexOf("session-adopt")).toBeLessThan(order.indexOf("caller-adopt"));
	});
});
