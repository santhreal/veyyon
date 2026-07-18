import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

// Root help splits diagnostic/dev tooling (devTool = true) into its own section
// so the main COMMANDS list reads as the product surface.

describe("root help sections", () => {
	it("lists diagnostic commands under DIAGNOSTIC COMMANDS, not COMMANDS", async () => {
		const { env, cleanup } = hermeticSpawnEnv();
		let stdout: string;
		try {
			const proc = Bun.spawn([process.execPath, cliEntry, "--help"], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			stdout = await new Response(proc.stdout).text();
			await proc.exited;
		} finally {
			cleanup();
		}

		const commandsIdx = stdout.indexOf("COMMANDS\n");
		const diagIdx = stdout.indexOf("DIAGNOSTIC COMMANDS\n");
		expect(commandsIdx).toBeGreaterThan(-1);
		expect(diagIdx).toBeGreaterThan(commandsIdx);

		const mainSection = stdout.slice(commandsIdx, diagIdx);
		const diagSection = stdout.slice(diagIdx);
		for (const dev of ["gallery", "ttsr", "dry-balance", "grep", "grievances"]) {
			expect(mainSection).not.toMatch(new RegExp(`^  ${dev} `, "m"));
			expect(diagSection).toMatch(new RegExp(`^  ${dev} `, "m"));
		}
		for (const user of ["plugin", "config", "setup", "update", "models"]) {
			expect(mainSection).toMatch(new RegExp(`^  ${user} `, "m"));
		}
	}, 30000);
});
