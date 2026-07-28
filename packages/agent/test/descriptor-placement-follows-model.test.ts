import { describe, expect, it } from "bun:test";
import { type Api, type Model, z } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

const baseModel = createMockModel({ responses: [] }).model;
const geminiModel = { ...baseModel, id: "gemini-3-pro" };
const nativeModel = { ...baseModel, id: "gpt-5.6" };

const tool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo a message",
	parameters: z.object({ message: z.string().describe("message body") }) as unknown as AgentTool["parameters"],
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

function agentWithPolicy(pruneToolDescriptions: boolean | ((model: Model<Api>) => boolean)): Agent {
	return new Agent({
		initialState: { model: geminiModel, systemPrompt: ["system"], tools: [tool], messages: [] },
		pruneToolDescriptions,
	});
}

async function descriptorState(agent: Agent): Promise<{ description: string; schema: string }> {
	const context = await agent.buildSideRequestContext([]);
	return {
		description: context.tools?.[0]?.description ?? "",
		schema: JSON.stringify(context.tools?.[0]?.parameters),
	};
}

describe("tool descriptor placement follows the active model", () => {
	/** Locks out the session-start capture that kept Gemini's larger inline representation after switching to a native model. */
	it("restores native descriptions after switching away from an inline model", async () => {
		const agent = agentWithPolicy(model => model.id.startsWith("gemini"));
		expect(await descriptorState(agent)).toEqual({
			description: "",
			schema:
				'{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}',
		});

		agent.setModel(nativeModel);
		expect(await descriptorState(agent)).toEqual({
			description: "Echo a message",
			schema:
				'{"type":"object","properties":{"message":{"type":"string","description":"message body"}},"required":["message"],"additionalProperties":false}',
		});
	});

	/** Proves model-family placement is reversible rather than a one-way migration cached after the first switch. */
	it("prunes descriptions again when switching back to an inline model", async () => {
		const agent = agentWithPolicy(model => model.id.startsWith("gemini"));
		agent.setModel(nativeModel);
		expect((await descriptorState(agent)).description).toBe("Echo a message");

		agent.setModel(geminiModel);
		expect(await descriptorState(agent)).toEqual({
			description: "",
			schema:
				'{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}',
		});
	});

	/** Preserves the explicit-on compatibility contract: a fixed true setting must override every model-family default. */
	it("keeps descriptions pruned for a fixed true policy", async () => {
		const agent = agentWithPolicy(true);
		agent.setModel(nativeModel);
		expect(await descriptorState(agent)).toEqual({
			description: "",
			schema:
				'{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}',
		});
	});

	/** Preserves the explicit-off compatibility contract: a fixed false setting must retain exact provider-facing descriptions. */
	it("keeps descriptions on the wire for a fixed false policy", async () => {
		const agent = agentWithPolicy(false);
		expect(await descriptorState(agent)).toEqual({
			description: "Echo a message",
			schema:
				'{"type":"object","properties":{"message":{"type":"string","description":"message body"}},"required":["message"],"additionalProperties":false}',
		});
	});
});
