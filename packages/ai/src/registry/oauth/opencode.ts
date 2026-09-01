import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://opencode.ai/auth";

export async function loginOpenCode(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("OpenCode Zen");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Log in and copy your API key",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your OpenCode Zen API key",
		placeholder: "sk-...",
		secret: true,
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	return trimmed;
}
