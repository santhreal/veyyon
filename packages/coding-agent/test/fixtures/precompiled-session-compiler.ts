/**
 * Creates one agent session, builds every first-party tool, renders the default system prompt's
 * statement sequence at every point of the statement matrix and builds a custom-prompt system
 * prompt, and prints as JSON the Handlebars compiler modules evaluated after each stage, what each
 * stage rendered, and the statements holding a mustache that no build-time compilation registered.
 *
 * Driven by `test/a-session-of-precompiled-prompts-evaluates-no-handlebars-compiler.test.ts`.
 * Run under `precompiled-prompt-modules-preload.ts`, every `.md` import registers its build-time
 * compilation as it does in the binary; run without it, nothing is registered, as in a run from
 * source. argv[2] is the scratch directory; every path under it prints as `<scratch>`, and every path
 * under the home directory as `<home>`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem, prompt } from "@veyyon/utils";
import { precompiledTemplate } from "@veyyon/utils/prompt-precompiled";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { buildSystemPrompt } from "../../src/system-prompt";
import {
	assembleStatementSectionTemplates,
	defaultTemplatePieces,
} from "../../src/system-prompt-builder/default-template";
import { PROMPT_STATEMENTS } from "../../src/system-prompt-builder/statement-registry";
import { MATRIX } from "../core/statement-matrix";
import { visitEveryFirstPartyTool } from "../helpers/every-first-party-tool";

const COMPILER_DIR = `${path.sep}handlebars${path.sep}dist${path.sep}cjs${path.sep}handlebars${path.sep}compiler${path.sep}`;

/** The Handlebars compiler modules evaluated so far, by file name. */
function compilerModules(): string[] {
	return Object.keys(require.cache)
		.map(file => path.normalize(file))
		.filter(file => file.includes(COMPILER_DIR))
		.map(file => path.basename(file))
		.sort();
}

/** What the fixture prints. */
export interface PrecompiledSessionReport {
	/** Statements whose text holds a mustache and has no registered build-time compilation. */
	readonly unregisteredStatements: string[];
	/** Compiler modules evaluated once each stage finished; each stage runs after the one before. */
	readonly compilerAfter: {
		readonly session: string[];
		readonly tools: string[];
		readonly matrix: string[];
		readonly customPrompt: string[];
	};
	readonly sessionPrompt: string[];
	readonly toolDescriptions: Record<string, string>;
	readonly matrixPrompts: string[];
	readonly customPrompt: string[];
}

try {
	const scratch = process.argv[2];
	if (!scratch) throw new Error("usage: precompiled-session-compiler.ts <scratch-dir>");
	const scrub = (text: string): string => text.replaceAll(scratch, "<scratch>").replaceAll(os.homedir(), "<home>");
	const cwd = path.join(scratch, "project");
	const agentDir = path.join(scratch, "agent");
	fs.mkdirSync(cwd, { recursive: true });

	const unregisteredStatements = PROMPT_STATEMENTS.filter(
		statement => statement.text.includes("{{") && precompiledTemplate(statement.text) === undefined,
	).map(statement => statement.id);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		model: getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	const sessionPrompt = session.systemPrompt.map(scrub);
	const afterSession = compilerModules();

	const toolDescriptions: Record<string, string> = {};
	await visitEveryFirstPartyTool(path.join(scratch, "sweep"), tool => {
		toolDescriptions[tool.name] = scrub(tool.description);
		toolWireSchema(tool);
	});
	const afterTools = compilerModules();

	const matrixPrompts = MATRIX.map(point =>
		prompt.renderSequence(defaultTemplatePieces(assembleStatementSectionTemplates(point.context)), point.context, {
			allowMissing: true,
		}),
	);
	const afterMatrix = compilerModules();

	const custom = await buildSystemPrompt({ cwd, agentDir, customPrompt: "A CUSTOM SYSTEM PROMPT BODY" });
	const customPrompt = custom.systemPrompt.map(scrub);
	const afterCustomPrompt = compilerModules();

	const report: PrecompiledSessionReport = {
		unregisteredStatements,
		compilerAfter: { session: afterSession, tools: afterTools, matrix: afterMatrix, customPrompt: afterCustomPrompt },
		sessionPrompt,
		toolDescriptions,
		matrixPrompts,
		customPrompt,
	};
	process.stdout.write(`${JSON.stringify(report)}\n`);
	await session.dispose();
} finally {
	await postmortem.cleanup();
}
