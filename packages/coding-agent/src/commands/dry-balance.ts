import { APP_NAME } from "@veyyon/utils";
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { runDryBalanceCommand } from "../cli/dry-balance-cli";

export default class DryBalance extends Command {
	static description = "Dry-run OAuth account balancing across random session ids";

	static devTool = true;

	static args = {
		model: Args.string({
			description: "Model selector (provider/model or fuzzy id). Defaults to the configured default model.",
			required: false,
		}),
	};

	static flags = {
		model: Flags.string({ description: `Model selector (same syntax as --model on ${APP_NAME})` }),
		count: Flags.integer({ description: "Number of random session ids to try", default: 100 }),
		concurrency: Flags.integer({ description: "Maximum concurrent credential resolutions", default: 32 }),
		json: Flags.boolean({ description: "Output JSON" }),
		bench: Flags.boolean({ description: "Send one live benchmark request per OAuth account" }),
	};

	static examples = [
		`# Dry-run the configured default model with 100 random session ids\n  ${APP_NAME} dry-balance`,
		`# Dry-run a specific model\n  ${APP_NAME} dry-balance anthropic/claude-sonnet-4-5`,
		`# Larger run with bounded concurrency\n  ${APP_NAME} dry-balance --model openai-codex/gpt-5-codex --count 1000 --concurrency 64`,
		`# Benchmark every OAuth account in parallel\n  ${APP_NAME} dry-balance --bench`,
		`# Machine-readable output\n  ${APP_NAME} dry-balance --json`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(DryBalance);
		await runDryBalanceCommand({
			model: args.model,
			flags: {
				model: flags.model,
				count: flags.count,
				concurrency: flags.concurrency,
				json: flags.json,
				bench: flags.bench,
			},
		});
	}
}
