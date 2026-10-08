/**
 * WHY. `parseSwarmYaml` and `validateSwarmDefinition` are the boundary between a hand-written swarm
 * file and the runner, and no test named either. A swarm file that parses wrong still runs: a role
 * read from the wrong key, a dropped `waits_for`, or a default mode other than `sequential` produces
 * a swarm that starts and does the wrong thing, and nothing downstream can tell.
 *
 * The class this closes: every required field rejected by name when missing or malformed (top-level
 * and per agent, including an agent entry with no mapping at all, which used to surface as a
 * `TypeError` reading `role` of null), the defaults (`sequential`, a target count of 1), the trimming
 * of task, extra context and model text, snake_case keys mapped to their camelCase fields, the
 * declaration order kept, and every semantic error `validateSwarmDefinition` reports, each alone so a
 * check that fires for the wrong reason cannot hide behind another one.
 *
 * What it does not catch: how the runner uses a definition, which the dag and execution suites own.
 */
import { describe, expect, it } from "bun:test";
import { parseSwarmYaml, type SwarmAgent, type SwarmDefinition, validateSwarmDefinition } from "../src/swarm/schema";

const VALID = `
swarm:
  name: review.team_1
  workspace: ./work
  agents:
    writer:
      role: author
      task: "  write the draft  "
      extra_context: "  house style  "
      model: "  gpt-x  "
    editor:
      role: reviewer
      task: edit it
      waits_for: [writer]
      reports_to: [writer]
`;

function definitionOf(overrides: Partial<SwarmDefinition>): SwarmDefinition {
	return { ...parseSwarmYaml(VALID), ...overrides };
}

describe("parseSwarmYaml", () => {
	it("maps every field of a valid file, applying the defaults and trimming the text fields", () => {
		const def = parseSwarmYaml(VALID);
		expect(def.name).toBe("review.team_1");
		expect(def.workspace).toBe("./work");
		expect(def.mode).toBe("sequential");
		expect(def.targetCount).toBe(1);
		expect(def.model).toBeUndefined();
		expect(def.agentOrder).toEqual(["writer", "editor"]);
		expect(def.agents.get("writer")).toEqual({
			name: "writer",
			role: "author",
			task: "write the draft",
			extraContext: "house style",
			reportsTo: [],
			model: "gpt-x",
			waitsFor: [],
		});
		expect(def.agents.get("editor")).toEqual({
			name: "editor",
			role: "reviewer",
			task: "edit it",
			extraContext: undefined,
			reportsTo: ["writer"],
			model: undefined,
			waitsFor: ["writer"],
		});
	});

	it("reads the mode, target count and trimmed swarm model when the file states them", () => {
		const def = parseSwarmYaml(
			`swarm:\n  name: s\n  workspace: w\n  mode: pipeline\n  target_count: 3\n  model: "  m1  "\n  agents:\n    a: { role: r, task: t }\n`,
		);
		expect(def.mode).toBe("pipeline");
		expect(def.targetCount).toBe(3);
		expect(def.model).toBe("m1");
	});

	it.each([
		["no swarm key", "other: 1\n", "YAML must have a top-level 'swarm' key"],
		["an empty document", "", "YAML must have a top-level 'swarm' key"],
		[
			"no name",
			"swarm:\n  workspace: w\n  agents:\n    a: { role: r, task: t }\n",
			"swarm.name is required and must be a string",
		],
		[
			"a non-string name",
			"swarm:\n  name: [x]\n  workspace: w\n  agents:\n    a: { role: r, task: t }\n",
			"swarm.name is required and must be a string",
		],
		[
			"a name with a slash",
			"swarm:\n  name: a/b\n  workspace: w\n  agents:\n    a: { role: r, task: t }\n",
			"swarm.name may only contain letters, numbers, dot, underscore, and dash",
		],
		[
			"no workspace",
			"swarm:\n  name: s\n  agents:\n    a: { role: r, task: t }\n",
			"swarm.workspace is required and must be a string",
		],
		["no agents", "swarm:\n  name: s\n  workspace: w\n", "swarm.agents must contain at least one agent"],
		[
			"an empty agents map",
			"swarm:\n  name: s\n  workspace: w\n  agents: {}\n",
			"swarm.agents must contain at least one agent",
		],
		[
			"an unknown mode",
			"swarm:\n  name: s\n  workspace: w\n  mode: swirl\n  agents:\n    a: { role: r, task: t }\n",
			"Invalid mode 'swirl'. Must be one of: pipeline, parallel, sequential",
		],
		[
			"an agent with no mapping",
			"swarm:\n  name: s\n  workspace: w\n  agents:\n    a:\n",
			"Agent 'a' must be a mapping with 'role' and 'task'",
		],
		[
			"an agent with a scalar entry",
			"swarm:\n  name: s\n  workspace: w\n  agents:\n    a: just text\n",
			"Agent 'a' must be a mapping with 'role' and 'task'",
		],
		[
			"an agent with no role",
			"swarm:\n  name: s\n  workspace: w\n  agents:\n    a: { task: t }\n",
			"Agent 'a': 'role' is required",
		],
		[
			"an agent with no task",
			"swarm:\n  name: s\n  workspace: w\n  agents:\n    a: { role: r }\n",
			"Agent 'a': 'task' is required",
		],
	])("rejects a file with %s", (_case, yaml, message) => {
		expect(() => parseSwarmYaml(yaml)).toThrow(message);
	});
});

describe("validateSwarmDefinition", () => {
	it("reports nothing for a valid definition", () => {
		expect(validateSwarmDefinition(parseSwarmYaml(VALID))).toEqual([]);
	});

	it.each<[string, Partial<SwarmDefinition>, string[]]>([
		["an empty swarm model", { model: "" }, ["swarm.model must not be empty when provided"]],
		[
			"a target count below 1 in pipeline mode",
			{ mode: "pipeline", targetCount: 0 },
			["target_count must be at least 1"],
		],
		[
			"a target count other than 1 outside pipeline mode",
			{ mode: "parallel", targetCount: 2 },
			["target_count is only supported in pipeline mode"],
		],
	])("reports %s", (_case, overrides, errors) => {
		expect(validateSwarmDefinition(definitionOf(overrides))).toEqual(errors);
	});

	it.each<[string, Partial<SwarmAgent>, string[]]>([
		["waits for an unknown agent", { waitsFor: ["ghost"] }, ["Agent 'writer' waits_for unknown agent 'ghost'"]],
		["waits for itself", { waitsFor: ["writer"] }, ["Agent 'writer' cannot wait for itself"]],
		["reports to an unknown agent", { reportsTo: ["ghost"] }, ["Agent 'writer' reports_to unknown agent 'ghost'"]],
		["reports to itself", { reportsTo: ["writer"] }, ["Agent 'writer' cannot report to itself"]],
		["has an empty model", { model: "" }, ["Agent 'writer' model must not be empty when provided"]],
	])("reports an agent that %s", (_case, agentOverrides, errors) => {
		const def = parseSwarmYaml(VALID);
		const writer = def.agents.get("writer")!;
		def.agents.set("writer", { ...writer, ...agentOverrides });
		expect(validateSwarmDefinition(def)).toEqual(errors);
	});
});
