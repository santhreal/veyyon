import { describe, expect, it } from "bun:test";
import { type Message, z } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { INTENT_FIELD } from "@veyyon/wire";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

/**
 * Contracts: `intentTracing` is resolved per request, so flipping it mid-session reaches the schemas.
 *
 * WHAT INTENT TRACING IS. When it is on, the harness injects one extra string field into every tool
 * schema it sends the model, asks for a short description of what the call is for, and strips that
 * field back out of the arguments before the tool runs. The system prompt carries a bullet explaining
 * the field. Both halves come from one setting, `tools.intentTracing`.
 *
 * WHY THIS SUITE EXISTS. `Agent` took `intentTracing` as a boolean and stored it, so the answer was
 * whatever it had been at construction. `sdk.ts` read the setting into a closure constant one line
 * above `rebuildSystemPrompt`, which meant a mid-session flip changed the settings UI and nothing else:
 * the prompt kept its old text and the schemas kept their old shape, with nothing anywhere saying the
 * change had not taken. `gate-registry.ts` recorded that as `frozen-by-placement` and its `because`
 * spelled out why moving the read was not enough on its own -- the same constant decided the schema
 * injection, and a prompt explaining a field the schemas do not carry is worse than one that omits it.
 *
 * So the option accepts a RESOLVER. `Agent` calls it where it builds the provider context and again
 * where it builds the loop config, both per turn, and the gate is live.
 *
 * WHAT THIS FILE PROVES AND WHAT IT CANNOT. It drives the SCHEMA half, which is the half a prompt test
 * cannot see: `test/core/prompt-gate-inputs.test.ts` in `coding-agent` flips the setting and checks the
 * bullet appears and disappears, and it would pass exactly the same way on a build where the tool
 * schemas never changed at all. That was the actual defect. The observable here is
 * `buildSideRequestContext`, which is public and runs the same `normalizeTools` call the loop does.
 */

const INTENT_DESCRIPTION_HINT = "intent";

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `the ${name} tool`,
		parameters: z.object({ path: z.string() }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { value: "ok" } }),
	};
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as unknown as Message;
}

/** Build an agent whose intent tracing follows `read`, plus the switch that flips it. */
function agentWithToggle(initial: boolean, tools: AgentTool[] = [tool("read"), tool("write")]) {
	let enabled = initial;
	const agent = new Agent({
		initialState: {
			model: createMockModel({ responses: [] }),
			systemPrompt: ["system"],
			tools,
		},
		intentTracing: () => enabled,
	});
	return {
		agent,
		set(next: boolean) {
			enabled = next;
		},
	};
}

/** The parameter names one normalized tool schema carries. */
function parameterNames(schema: unknown): string[] {
	const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
	return properties === undefined ? [] : Object.keys(properties);
}

async function schemaFor(agent: Agent, toolName: string) {
	const context = await agent.buildSideRequestContext([userMessage("go")]);
	const found = context.tools?.find(candidate => candidate.name === toolName);
	expect(found, `${toolName} is missing from the provider context`).toBeDefined();
	return found as NonNullable<typeof found>;
}

describe("the intent field follows the resolver, request by request", () => {
	/**
	 * THE REGRESSION. Two calls to the same agent, with the setting flipped in between, must disagree.
	 * This is the assertion that fails on a build that captures the value at construction, and it is
	 * the reason the option is a function rather than a boolean.
	 */
	it("adds the intent field to an existing agent's schemas when the setting is turned on", async () => {
		const { agent, set } = agentWithToggle(false);

		expect(parameterNames((await schemaFor(agent, "read")).parameters)).not.toContain(INTENT_FIELD);
		set(true);

		expect(parameterNames((await schemaFor(agent, "read")).parameters)).toContain(INTENT_FIELD);
	});

	/** And back off again, because a resolver read once and cached would pass the test above. */
	it("removes it again when the setting is turned off", async () => {
		const { agent, set } = agentWithToggle(true);

		expect(parameterNames((await schemaFor(agent, "read")).parameters)).toContain(INTENT_FIELD);
		set(false);

		expect(parameterNames((await schemaFor(agent, "read")).parameters)).not.toContain(INTENT_FIELD);
	});

	/**
	 * EVERY tool, not the first one. The field is injected per schema, so a change that reached one
	 * tool and not the rest would leave the model told about a field half its tools do not accept.
	 */
	it("reaches every tool in the catalog, not just the first", async () => {
		const { agent, set } = agentWithToggle(false, [tool("read"), tool("write"), tool("bash")]);

		set(true);
		const context = await agent.buildSideRequestContext([userMessage("go")]);

		expect(context.tools?.length).toBe(3);
		for (const schema of context.tools ?? []) {
			expect(parameterNames(schema.parameters), `${schema.name} has no intent field`).toContain(INTENT_FIELD);
		}
	});

	/**
	 * The tool's OWN parameters survive the injection. An implementation that replaced the schema
	 * rather than extending it would satisfy every assertion above and break every tool call.
	 */
	it("adds the field alongside the tool's own parameters rather than replacing them", async () => {
		const { agent } = agentWithToggle(true);

		const names = parameterNames((await schemaFor(agent, "read")).parameters);

		expect(names).toContain("path");
		expect(names).toContain(INTENT_FIELD);
		expect(names).toHaveLength(2);
	});

	/**
	 * The injected field carries a description, because the model has to be told what to put in it. An
	 * unnamed extra string in every schema is worse than no field at all.
	 */
	it("describes the field it injects", async () => {
		const { agent } = agentWithToggle(true);

		const schema = (await schemaFor(agent, "read")).parameters as {
			properties?: Record<string, { type?: string; description?: string }>;
		};
		const injected = schema.properties?.[INTENT_FIELD];

		expect(injected?.type).toBe("string");
		expect(injected?.description?.toLowerCase()).toContain(INTENT_DESCRIPTION_HINT);
	});

	/**
	 * The rest of the schema is untouched between the two answers. Asserted by comparing the whole
	 * serialized schema minus the injected field, so a change that also reordered or rewrote something
	 * else shows up here rather than in a provider 400 much later.
	 */
	it("changes nothing but the injected field", async () => {
		const { agent, set } = agentWithToggle(false);

		const off = (await schemaFor(agent, "read")).parameters as { properties?: Record<string, unknown> };
		set(true);
		const on = (await schemaFor(agent, "read")).parameters as { properties?: Record<string, unknown> };

		const { [INTENT_FIELD]: _injected, ...onWithoutIntent } = on.properties ?? {};
		expect(onWithoutIntent).toEqual(off.properties ?? {});
	});
});

describe("a plain boolean still works", () => {
	/**
	 * The option accepts a value as well as a resolver, for a caller whose answer genuinely cannot
	 * change. Both forms normalize to a resolver once, in the constructor, so nothing downstream has to
	 * know which arrived. Pinned because a union with only one exercised arm is a union that breaks.
	 */
	it("injects the field when passed true", async () => {
		const agent = new Agent({
			initialState: { model: createMockModel({ responses: [] }), systemPrompt: ["system"], tools: [tool("read")] },
			intentTracing: true,
		});

		expect(parameterNames((await schemaFor(agent, "read")).parameters)).toContain(INTENT_FIELD);
	});

	it("omits it when passed false", async () => {
		const agent = new Agent({
			initialState: { model: createMockModel({ responses: [] }), systemPrompt: ["system"], tools: [tool("read")] },
			intentTracing: false,
		});

		expect(parameterNames((await schemaFor(agent, "read")).parameters)).not.toContain(INTENT_FIELD);
	});

	/**
	 * And omitted means off, which is the default every caller that does not opt in gets. Checked
	 * separately from `false` because `opts.intentTracing === true` and `!!opts.intentTracing` differ
	 * for exactly one input and that input is `undefined`.
	 */
	it("omits it when the option is absent", async () => {
		const agent = new Agent({
			initialState: { model: createMockModel({ responses: [] }), systemPrompt: ["system"], tools: [tool("read")] },
		});

		expect(parameterNames((await schemaFor(agent, "read")).parameters)).not.toContain(INTENT_FIELD);
	});
});
