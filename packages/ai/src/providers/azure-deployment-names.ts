/**
 * Parse `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` (`model=deployment,model=deployment`)
 * into a model id to deployment name map. Entries without both halves are skipped.
 *
 * A zero-import leaf: the remote summarizer resolves its wire model through it on
 * the launch graph, and importing it from `openai-shared.ts` pulled the OpenAI
 * request builders onto every launch.
 */
export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}
