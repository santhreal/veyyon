import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolCall } from "@veyyon/agent-core";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createRepairToolCallArgumentsHook, formatUnrepairableToolError } from "@veyyon/coding-agent/repair/agent-hook";

const tool = {
	name: "demo",
	description: "demo",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
} as unknown as AgentTool;

const toolCall: AgentToolCall = {
	type: "toolCall",
	id: "tc-1",
	name: "demo",
	arguments: { __parseError: "bad", __rawJson: '{"path": "/x",}' },
};

describe("repair agent hook", () => {
	it("repairs through the agent-loop adapter", () => {
		const settings = Settings.isolated({ "harness.profiles": {} });
		const hook = createRepairToolCallArgumentsHook(settings, () => undefined);
		const outcome = hook(tool, toolCall);
		expect(outcome.status).toBe("repaired");
		if (outcome.status !== "repaired") return;
		expect(outcome.arguments).toEqual({ path: "/x" });
	});

	it("honors per-model repair disable", () => {
		const settings = Settings.isolated({
			"harness.profiles": { "openai/*": { repair: false } },
		});
		const hook = createRepairToolCallArgumentsHook(settings, () =>
			buildModel({
				id: "m",
				name: "m",
				provider: "openai",
				api: "openai-completions",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1,
				maxTokens: 1,
			}),
		);
		const outcome = hook(tool, toolCall);
		expect(outcome.status).toBe("clean");
	});

	it("formats unrepairable coaching text", () => {
		const text = formatUnrepairableToolError("nope", ["fix the JSON"]);
		expect(text).toContain("nope");
		expect(text).toContain("[Tool argument repair]");
		expect(text).toContain("fix the JSON");
	});
});
