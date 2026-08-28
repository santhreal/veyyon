import type { Context, Model, TSchema } from "@veyyon/ai";
import { type Dialect, renderToolExamples } from "@veyyon/ai/dialect";
import { stripSchemaDescriptions, toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { isRecord } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, AsideMessage, ConfiguredDialect } from "./types";

export function resolveConfiguredDialect(configured: ConfiguredDialect | undefined, model: Model): Dialect | undefined {
	const resolved = typeof configured === "function" ? configured(model) : configured;
	return resolved ?? resolveOwnedDialectFromEnv(Bun.env.VEYYON_DIALECT);
}

export function resolveOwnedDialectFromEnv(value: string | undefined): Dialect | undefined {
	switch (value) {
		case "1":
		case "true":
			return "glm";
		case "glm":
		case "hermes":
		case "kimi":
		case "xml":
		case "anthropic":
		case "deepseek":
		case "harmony":
		case "qwen3":
		case "gemini":
		case "gemma":
		case "minimax":
		case "pi-native":
			return value;
		default:
			return undefined;
	}
}

export function normalizeMessagesForProvider(
	messages: Context["messages"],
	model: AgentLoopConfig["model"],
): Context["messages"] {
	if (model.provider !== "cerebras") {
		return messages;
	}

	let hasThinking = false;
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "thinking") {
				hasThinking = true;
				break;
			}
		}
		if (hasThinking) break;
	}
	if (!hasThinking) return messages;

	return messages.map(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}
		const filtered = message.content.filter(block => block.type !== "thinking");
		return filtered.length === message.content.length ? message : { ...message, content: filtered };
	});
}

const INTENT_FIELD_DESCRIPTION = "concise intent";
const INTENT_SCHEMA_UNION_KEYS = ["anyOf", "oneOf"] as const;

export function injectIntentIntoSchema(
	schema: unknown,
	mode: "require" | "optional" = "require",
	describeIntent = true,
): unknown {
	if (!isRecord(schema)) return schema;
	const propertiesValue = schema.properties;
	const hasOwnProperties = isRecord(propertiesValue);

	if (!hasOwnProperties) {
		for (const key of INTENT_SCHEMA_UNION_KEYS) {
			const variants = schema[key];
			if (!Array.isArray(variants)) continue;
			return {
				...schema,
				[key]: variants.map(variant => injectIntentIntoSchema(variant, mode, describeIntent)),
			};
		}
	}

	const properties = hasOwnProperties ? (propertiesValue as Record<string, unknown>) : {};
	const requiredValue = schema.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) {
		const { [INTENT_FIELD]: intentProp, ...rest } = properties;
		const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
		const needsRequired = mode === "require" && !required.includes(INTENT_FIELD);
		if (!needsReorder && !needsRequired) return schema;
		return {
			...schema,
			...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
			...(needsRequired ? { required: required.concat(INTENT_FIELD) } : {}),
		};
	}
	return {
		...schema,
		properties: {
			[INTENT_FIELD]: describeIntent
				? { type: "string", description: INTENT_FIELD_DESCRIPTION }
				: { type: "string" },
			...properties,
		},
		...(mode === "require" ? { required: required.concat(INTENT_FIELD) } : {}),
	};
}

const normalizedToolsCache = new WeakMap<
	NonNullable<AgentContext["tools"]>,
	{ key: string; result: Context["tools"] }
>();

export function normalizeTools(
	tools: NonNullable<AgentContext["tools"]>,
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions?: boolean,
): NonNullable<Context["tools"]>;
export function normalizeTools(
	tools: AgentContext["tools"],
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions?: boolean,
): Context["tools"];
export function normalizeTools(
	tools: AgentContext["tools"],
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions = false,
): Context["tools"] {
	if (!tools) return tools;
	const valid = tools.filter(
		(t): t is NonNullable<(typeof tools)[number]> => isRecord(t) && typeof t.name === "string",
	);
	injectIntent = injectIntent && Bun.env.VEYYON_NO_INTENT !== "1";
	const cacheKey = `${injectIntent}|${exampleDialect ?? ""}|${pruneDescriptions}`;
	const cached = normalizedToolsCache.get(tools);
	if (cached && cached.key === cacheKey) return cached.result;
	const result = valid.map(t => {
		const intentMode = resolveIntentMode(t.intent);
		const doInjectIntent = injectIntent && intentMode !== "omit";
		if (pruneDescriptions) {
			let parameters = stripSchemaDescriptions(toolWireSchema(t)) as TSchema;
			if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode, false) as TSchema;
			return { ...t, parameters, description: "" };
		}
		let parameters = toolWireSchema(t) as TSchema;
		if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode) as TSchema;
		const description = t.description ?? "";
		const examplesBlock = exampleDialect
			? renderToolExamples({ ...t, parameters }, exampleDialect, doInjectIntent ? INTENT_FIELD : undefined)
			: "";
		const finalDescription = examplesBlock ? `${description}\n\n${examplesBlock}` : description;
		return { ...t, parameters, description: finalDescription };
	});
	normalizedToolsCache.set(tools, { key: cacheKey, result });
	return result;
}

export function resolveIntentMode(intent: AgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return "require";
}

export function extractIntent(args: Record<string, unknown>): {
	intent?: string;
	strippedArgs: Record<string, unknown>;
} {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

export function resolveAsides(entries: AsideMessage[] | undefined): AgentMessage[] {
	if (!entries || entries.length === 0) return [];
	const out: AgentMessage[] = [];
	for (const entry of entries) {
		const message = typeof entry === "function" ? entry() : entry;
		if (message) out.push(message);
	}
	return out;
}
