/**
 * WHY THIS SUITE EXISTS:
 *
 * In DeepSWE, retried trials previously ran `docker rm -f $(docker ps -aq --filter name=<jobName>)`
 * (substring match) followed by a global `docker network prune -f`.
 * In parallel runs, this killed sibling trials and unrelated operator containers.
 *
 * This test asserts that executor cleanup uses scoped container and network removal
 * by exact name/label matching, never issues a network prune, and never uses substring matching.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Docker daemon connection failures or socket permissions.
 */

import { describe, expect, it } from "bun:test";
import { cleanupPierContainers } from "../../../backends/pier/runner";

describe("DeepSWE Executor Cleanup — exact scoped cleanup without prune or substring match", () => {
	it("removes only matching containers and networks without pruning or substring match", async () => {
		const targetJobName = "evals-run-123__baseline__task-42__r0";
		const siblingJobName = "evals-run-123__baseline__task-420__r0"; // Substring collision!
		const unrelatedContainer = "operator-postgres-db";

		const commandsIssued: Array<{ file: string; args: readonly string[] }> = [];

		const mockExec = async (file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
			commandsIssued.push({ file, args });

			if (args[0] === "ps") {
				// Return containers: target, substring collision, and unrelated
				const lines = [
					`c_target\t/${targetJobName}-service-1\t${targetJobName}`,
					`c_sibling\t/${siblingJobName}-service-1\t${siblingJobName}`,
					`c_unrelated\t${unrelatedContainer}\t`,
				];
				return { stdout: `${lines.join("\n")}\n`, stderr: "" };
			}

			if (args[0] === "network" && args[1] === "ls") {
				// Return networks: target, substring collision, and unrelated
				const lines = [
					`net_target\t${targetJobName}_default\t${targetJobName}`,
					`net_sibling\t${siblingJobName}_default\t${siblingJobName}`,
					"net_bridge\tbridge\t",
				];
				return { stdout: `${lines.join("\n")}\n`, stderr: "" };
			}

			return { stdout: "", stderr: "" };
		};

		await cleanupPierContainers(targetJobName, mockExec);

		// 1. Assert docker network prune is NEVER called
		for (const cmd of commandsIssued) {
			expect(cmd.args).not.toEqual(["network", "prune", "-f"]);
			expect(cmd.args).not.toContain("prune");
		}

		// 2. Assert docker rm was called for exact target container ID only
		const rmCmd = commandsIssued.find(c => c.args[0] === "rm");
		expect(rmCmd).toBeDefined();
		expect(rmCmd?.args).toEqual(["rm", "-f", "c_target"]);

		// 3. Assert docker network rm was called for exact target network ID only
		const netRmCmd = commandsIssued.find(c => c.args[0] === "network" && c.args[1] === "rm");
		expect(netRmCmd).toBeDefined();
		expect(netRmCmd?.args).toEqual(["network", "rm", "net_target"]);

		// 4. Sibling and unrelated IDs must never appear in any rm command
		for (const cmd of commandsIssued) {
			expect(cmd.args).not.toContain("c_sibling");
			expect(cmd.args).not.toContain("c_unrelated");
			expect(cmd.args).not.toContain("net_sibling");
			expect(cmd.args).not.toContain("net_bridge");
		}
	});
});
