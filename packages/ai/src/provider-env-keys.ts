import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $pickenv } from "@veyyon/utils/env";
import { isFoundryEnabled } from "./utils/foundry";

export type KeyResolver = string | (() => string | undefined);

export const AUTHENTICATED_API_KEY_SENTINEL = "<authenticated>";

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		const gacPath = $env.GOOGLE_APPLICATION_CREDENTIALS;
		if (gacPath) {
			cachedVertexAdcCredentialsExists = fs.existsSync(gacPath);
		} else {
			cachedVertexAdcCredentialsExists = fs.existsSync(
				path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

export function resetVertexAdcProbeForTests(): void {
	cachedVertexAdcCredentialsExists = null;
}

function amazonBedrockEnvKey(): string | undefined {
	const hasEcsCredentials = !!$env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!$env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	const hasWebIdentity = !!$env.AWS_WEB_IDENTITY_TOKEN_FILE && !!$env.AWS_ROLE_ARN;
	if (
		$env.AWS_PROFILE ||
		($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) ||
		$env.AWS_BEARER_TOKEN_BEDROCK ||
		hasEcsCredentials ||
		hasWebIdentity
	) {
		return AUTHENTICATED_API_KEY_SENTINEL;
	}
	return undefined;
}

function googleVertexEnvKey(): string | undefined {
	if ($env.GOOGLE_CLOUD_API_KEY) {
		return $env.GOOGLE_CLOUD_API_KEY;
	}
	const hasCredentials = hasVertexAdcCredentials();
	const hasProject = !!($env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT);
	const hasLocation = !!($env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION);
	if (hasCredentials && hasProject && hasLocation) {
		return AUTHENTICATED_API_KEY_SENTINEL;
	}
	return undefined;
}

function anthropicEnvKey(): string | undefined {
	return isFoundryEnabled()
		? $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
		: $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY");
}

export const PROVIDER_ENV_KEY_OVERRIDES: Readonly<Record<string, KeyResolver>> = {
	anthropic: anthropicEnvKey,
	"amazon-bedrock": amazonBedrockEnvKey,
	"google-vertex": googleVertexEnvKey,
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	brave: "BRAVE_API_KEY",
	exa: "EXA_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
	jina: "JINA_API_KEY",
	kagi: "KAGI_API_KEY",
	"llama.cpp": "LLAMA_CPP_API_KEY",
	parallel: "PARALLEL_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
	tavily: "TAVILY_API_KEY",
	tinyfish: "TINYFISH_API_KEY",
};
