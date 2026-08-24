/**
 * Custom-tool `exec` must refuse before the process exists.
 *
 * Adopting after spawn still lets a saturated session start work. The
 * contract is: `beforeSpawn` runs first, and a throw there never reaches
 * `ptree.exec`.
 */
import { describe, expect, it } from "bun:test";
import { execCommand } from "../src/exec/exec";
import { StdioTransport, StdioTransport } from "../src/mcp/transports/stdio";

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
