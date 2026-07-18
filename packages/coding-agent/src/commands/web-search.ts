/**
 * Run a web search through a configured provider and show the raw results.
 */
import { Args, Command, Flags } from "@veyyon/utils/cli";
import {
	runSearchCommand,
	SEARCH_PROVIDERS,
	SEARCH_RECENCY_OPTIONS,
	type SearchCommandArgs,
} from "../cli/web-search-cli";

export default class Search extends Command {
	static description = "Run a web search through a configured provider and show the raw results";

	static devTool = true;

	static aliases = ["q"];

	static args = {
		query: Args.string({ description: "Search query text", required: false, multiple: true }),
	};

	static flags = {
		provider: Flags.string({ description: "Search provider", options: SEARCH_PROVIDERS }),
		recency: Flags.string({ description: "Recency filter", options: SEARCH_RECENCY_OPTIONS }),
		limit: Flags.integer({ char: "l", description: "Max results to return" }),
		compact: Flags.boolean({ description: "Render condensed output" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Search);
		const query = Array.isArray(args.query) ? args.query.join(" ") : (args.query ?? "");

		const cmd: SearchCommandArgs = {
			query,
			provider: flags.provider as SearchCommandArgs["provider"],
			recency: flags.recency as SearchCommandArgs["recency"],
			limit: flags.limit,
			expanded: !flags.compact,
		};

		await runSearchCommand(cmd);
	}
}
