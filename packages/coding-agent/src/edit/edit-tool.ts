import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import hashlineGrammar from "@veyyon/hashline/grammar.lark" with { type: "text" };
import { HASHLINE_PROMPTS } from "@veyyon/hashline/prompts/registry";
import { prompt } from "@veyyon/utils";
import type { WritethroughCallback } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { PROMPTS } from "../prompts/registry";
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { isInternalUrlPath } from "../tools/path-utils";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import type { EditModeDefinition, EditParams, HashlineParams, TInput } from "./edit-tool-helpers";

export { editFilesystemTargets } from "./edit-tool-helpers";

import {
	createEditWritethrough,
	editFilesystemTargets,
	executeApplyPatchPerFile,
	executeSinglePathEntries,
	extractApprovalPath,
	resolveAllowFuzzy,
	resolveConfiguredEditMode,
	resolveFuzzyThreshold,
} from "./edit-tool-helpers";
import { executeHashlineSingle, hashlineEditParamsSchema } from "./hashline";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import { executePatchSingle, type PatchEditEntry, type PatchParams, patchEditSchema } from "./modes/patch";
import { executeReplaceSingle, type ReplaceEditEntry, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import { type EditToolDetails, getLspBatchRequest, type LspBatchRequest } from "./renderer";
import { EDIT_MODE_STRATEGIES } from "./streaming";

export class EditTool implements AgentTool<TInput> {
	readonly approval = (args: unknown) => {
		const targetPath = extractApprovalPath(args);
		return targetPath !== "(unknown)" && isInternalUrlPath(targetPath) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => [
		`File: ${truncateForPrompt(extractApprovalPath(args))}`,
	];
	readonly filesystemTargets = (args: unknown): string[] => editFilesystemTargets(args);
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #deferredDiagnostics: DeferredDiagnostics;

	constructor(private readonly session: ToolSession) {
		const {
			VEYYON_EDIT_FUZZY: editFuzzy = "auto",
			VEYYON_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			VEYYON_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		const deduplicateDiagnostics =
			(session.enableLsp ?? true) &&
			session.settings.get("lsp.enabled") &&
			session.settings.get("lsp.diagnosticsOnEdit") &&
			session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics = new DeferredDiagnostics(session, deduplicateDiagnostics);
		this.#writethrough = createEditWritethrough(session);
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	get examples(): readonly ToolExample[] | undefined {
		return this.#getModeDefinition().examples;
	}

	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode === "apply_patch") return { syntax: "lark", definition: applyPatchGrammar };
		if (this.mode === "hashline") return { syntax: "lark", definition: hashlineGrammar };
		return undefined;
	}

	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	matcherDigest(args: unknown): string | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherDigest(args);
	}

	matcherPaths(args: unknown): readonly string[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherPaths(args);
	}

	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherEntries(args);
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			patch: {
				description: () => prompt.render(PROMPTS["tools/patch"].text),
				parameters: patchEditSchema,
				examples: [
					{
						caption: "Create",
						call: { path: "hello.txt", edits: [{ op: "create", diff: "Hello\n" }] },
					},
					{
						caption: "Update",
						call: {
							path: "src/app.py",
							edits: [
								{
									op: "update",
									diff: "@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n",
								},
							],
						},
					},
					{
						caption: "Rename",
						call: {
							path: "src/app.py",
							edits: [{ op: "update", rename: "src/main.py", diff: "@@\n …\n" }],
						},
					},
					{
						caption: "Delete",
						call: { path: "obsolete.txt", edits: [{ op: "delete" }] },
					},
					{
						caption: "Multiple entries",
						note: "All entries in one call apply to the top-level `path`; use separate calls for different files.",
					},
				] satisfies readonly ToolExample<PatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as PatchParams;
					const runs = (edits as PatchEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								allowCreateOverwrite: true,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate, tool.session.cwd, signal);
				},
			},
			apply_patch: {
				description: () => prompt.render(PROMPTS["tools/apply-patch"].text),
				parameters: applyPatchSchema,
				examples: [
					{
						caption: "Apply a combined patch file",
						call: {
							input: '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n',
						},
					},
				] satisfies readonly ToolExample<ApplyPatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: (br: LspBatchRequest | undefined) =>
								executePatchSingle({
									session: tool.session,
									path,
									params: patchParams,
									signal,
									batchRequest: br,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
									writethrough: tool.#writethrough,
									beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
								}),
						};
					});
					return executeApplyPatchPerFile(perFile, batchRequest, tool.session.cwd, signal, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(HASHLINE_PROMPTS.prompt.text),
				parameters: hashlineEditParamsSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input } = params as HashlineParams;
					return executeHashlineSingle({
						session: tool.session,
						input,
						signal,
						batchRequest,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
					});
				},
			},
			replace: {
				description: () => prompt.render(PROMPTS["tools/replace"].text),
				parameters: replaceEditSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as ReplaceParams;
					const runs = (edits as ReplaceEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executeReplaceSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate, tool.session.cwd, signal);
				},
			},
		}[this.mode];
	}
}
