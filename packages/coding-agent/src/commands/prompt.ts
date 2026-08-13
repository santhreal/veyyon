/**
 * Print the system prompt this configuration would send.
 */
import { Command, Flags } from "@veyyon/utils/cli";
import { runPromptCommand } from "../cli/prompt-cli";

export default class Prompt extends Command {
	static description = "Print the assembled system prompt, or a breakdown of what it costs";

	static flags = {
		json: Flags.boolean({ description: "Output the inspection as JSON" }),
		sections: Flags.boolean({ description: "Show the per-section size breakdown instead of the prompt text" }),
		statements: Flags.boolean({
			description: "Show what each individual rule costs, and which rules this configuration leaves out",
		}),
		statement: Flags.string({
			description: "Print only this rule's text, or why it is not in this prompt (see --statements for the ids)",
		}),
		section: Flags.string({ description: "Print only this section (see --sections for the ids)" }),
		tools: Flags.boolean({
			description: "Show what each active tool's description and schema cost, which the prompt table does not",
		}),
		cwd: Flags.string({ description: "Working directory to resolve context files, skills and the tree from" }),
		"no-tools": Flags.boolean({ description: "Assemble with no tools, to see which regions are tool-gated" }),
		prompt: Flags.string({ description: "Which prompt to inspect (default: system; see --prompts for the ids)" }),
		prompts: Flags.boolean({ description: "List every prompt a model can be sent" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Prompt);
		const result = await runPromptCommand({
			json: flags.json,
			sections: flags.sections,
			statements: flags.statements,
			statement: flags.statement,
			section: flags.section,
			tools: flags.tools,
			cwd: flags.cwd,
			noTools: flags["no-tools"],
			prompt: flags.prompt,
			prompts: flags.prompts,
		});
		if (result.exitCode !== 0) {
			process.stderr.write(`${result.output}\n`);
			process.exitCode = result.exitCode;
			return;
		}
		process.stdout.write(`${result.output}\n`);
	}
}
