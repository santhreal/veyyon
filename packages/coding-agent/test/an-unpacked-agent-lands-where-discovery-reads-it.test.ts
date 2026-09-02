/**
 * WHY: `veyyon agents unpack` wrote its files to `<agentDir>/agents`, and
 * user-authored definitions are read from the global `subagents` dir. Both
 * halves were correct on their own, so nothing failed: the command printed a
 * list of written files and every one of them was inert. The starting point the
 * authoring flow hands an operator produced no agent at all.
 *
 * The class this closes is a writer and a reader of the same content resolving
 * different directories. Case 1 drives the real command handler and then the
 * real discovery pass, so the two must agree on one path or the suite goes red;
 * asserting the target string alone would pass again the next time discovery
 * moves. Case 2 pins the retired location as unread, which is what makes case 1
 * a claim about discovery rather than about a file existing somewhere.
 *
 * Not covered: whether a discovered agent may be SPAWNED. That is
 * `subagent.agents.<name>.enabled`, per profile, and it is asserted elsewhere.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runAgentsCommand } from "@veyyon/coding-agent/cli/agents-cli";
import { discoverAgents } from "@veyyon/coding-agent/task/discovery";
import { getGlobalSubagentsDir } from "@veyyon/utils";
import { useContextScopeFixture } from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("unpacked-agent-");

/** Run the command and return the target dir it reports, keeping its JSON off the runner's output. */
async function unpack(): Promise<string> {
	const write = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	};
	try {
		await runAgentsCommand({ action: "unpack", flags: { json: true } });
	} finally {
		process.stdout.write = write;
	}
	return (JSON.parse(captured) as { targetDir: string }).targetDir;
}

const DEFINITION = (name: string, description: string): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\nSystem prompt for ${name}.\n`;

describe("an unpacked agent lands where discovery reads it", () => {
	test("the unpacked file is the definition discovery returns", async () => {
		const f = fixture("unpack-profile");
		const targetDir = await unpack();

		const subagentsDir = getGlobalSubagentsDir();
		expect(targetDir).toBe(subagentsDir);
		expect(subagentsDir).toBe(path.join(f.globalRoot, "subagents"));
		const unpacked = fs
			.readdirSync(subagentsDir)
			.filter(name => name.endsWith(".md"))
			.map(name => name.slice(0, -3));
		expect(unpacked.length).toBeGreaterThan(0);

		// Editing an unpacked file is the whole point of unpacking one: the edit
		// must be what the model gets, which no name-membership check can show,
		// because the bundled definition carries the same name.
		const edited = unpacked[0];
		fs.writeFileSync(path.join(subagentsDir, `${edited}.md`), DEFINITION(edited, "EDITED-BY-THE-OPERATOR"));
		f.resetCaches();

		const { agents } = await discoverAgents(f.cwd, f.home);
		const discovered = agents.find(agent => agent.name === edited);
		expect(discovered?.description).toBe("EDITED-BY-THE-OPERATOR");
		expect(discovered?.source).toBe("user");
		// Every other unpacked file resolves to a definition too, so a partial
		// write path cannot pass on the strength of one name.
		expect(unpacked.filter(name => !agents.some(agent => agent.name === name))).toEqual([]);
	});

	test("a definition in the retired profile agents dir is not discovered", async () => {
		const f = fixture("retired-profile");
		f.writeFile(
			path.join(f.agentDir, "agents", "retired-location-agent.md"),
			DEFINITION("retired-location-agent", "d"),
		);
		f.resetCaches();

		const { agents } = await discoverAgents(f.cwd, f.home);

		expect(agents.some(agent => agent.name === "retired-location-agent")).toBe(false);
	});
});
