import { prompt } from "@veyyon/utils";
import type { BundledCommandAPI, CustomCommand } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import { requestsPrompts } from "../../../../prompts/requests/rows";

import { getHeadTagContext } from "./index-helpers";

export class GreenCommand implements CustomCommand {
	name = "green";
	description = "Generate a prompt to iterate on CI failures until the branch is green";

	constructor(private api: BundledCommandAPI) {}

	async execute(_args: string[], _ctx: HookCommandContext): Promise<string> {
		const { headTag, branch, remote } = await getHeadTagContext(this.api);
		return prompt.render(requestsPrompts["requests/ci-green"].text, { headTag, branch, remote });
	}
}
