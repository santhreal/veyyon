export interface ToolCallExample<TArgs = Record<string, unknown>> {
	caption?: string;
	call: TArgs;
}
export interface ToolCompareExample<TArgs = Record<string, unknown>> {
	caption?: string;
	bad: TArgs;
	good: TArgs;
}
export interface ToolNoteExample {
	caption: string;
	note?: string;
}
export type ToolExample<TArgs = Record<string, unknown>> =
	| ToolCallExample<TArgs>
	| ToolCompareExample<TArgs>
	| ToolNoteExample;

/**
 * What a tool states about itself independent of the schema library its parameters are written in.
 *
 * `Tool<TParameters>` in `@veyyon/ai` extends this with `parameters`, so a provider adapter reads the
 * schema and everything else reads the spec.
 */
export interface ToolSpec {
	name: string;
	description: string;
	/** If true, tool is strictly typed and validated against the parameters schema before execution */
	strict?: boolean;
	/**
	 * Optional grammar constraint for OpenAI custom-tool emission.
	 * When set, providers that support grammar-constrained tools (currently only
	 * `openai-responses` against models with the right capability flag) may emit
	 * this tool as `{type: "custom", format: {type: "grammar", …}}` instead of a
	 * JSON function tool. Other providers ignore the field.
	 */
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	/**
	 * Optional wire-level name used when this tool is emitted as a custom tool
	 * (e.g. OpenAI's `{type: "custom"}` shape). Models trained on specific tool
	 * names — like GPT-5 on `apply_patch` — need to see that exact name on the
	 * wire, but it may differ from the harness-internal `name`. The agent-loop
	 * dispatcher matches both `name` and `customWireName` so returned tool
	 * calls route correctly. Absent for regular JSON function tools.
	 */
	customWireName?: string;
	/**
	 * Illustrative calls/notes; the AI layer renders them into an `<examples>`
	 * block in the model's native tool-call syntax and appends to the wire
	 * description. Author `call`/`bad`/`good` as plain argument objects WITHOUT
	 * `i` — when intent tracing injects `i` into the schema, the renderer adds
	 * a placeholder `i` automatically. Type each tool's `examples` against its
	 * own schema (e.g. `readonly ToolExample<typeof schema["type"]>[]`).
	 */
	examples?: readonly ToolExample[];
}
