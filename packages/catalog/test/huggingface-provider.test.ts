import { describe, expect, test } from "bun:test";
import { huggingfaceModelManagerOptions } from "@veyyon/pi-catalog/provider-models/openai-compat";

describe("Hugging Face built-in provider", () => {
	test("stamps supportsTools: false only when every routed upstream reports it", async () => {
		const requests: string[] = [];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			requests.push(input.toString());
			return Response.json({
				data: [
					{
						id: "Qwen/Qwen2.5-Coder-3B-Instruct",
						object: "model",
						owned_by: "Qwen",
						providers: [
							{ provider: "hf-inference", status: "live", supports_tools: false },
							{ provider: "novita", status: "live", supports_tools: false },
						],
					},
					{
						id: "deepseek-ai/DeepSeek-V3.2",
						object: "model",
						owned_by: "deepseek-ai",
						providers: [
							{ provider: "novita", status: "live", supports_tools: false },
							{ provider: "fireworks-ai", status: "live", supports_tools: true },
						],
					},
					{
						id: "meta-llama/Llama-3.3-70B-Instruct",
						object: "model",
						owned_by: "meta-llama",
						providers: [{ provider: "together", status: "live" }],
					},
					{
						id: "no-providers/legacy-model",
						object: "model",
						owned_by: "unknown",
					},
				],
			});
		};

		const options = huggingfaceModelManagerOptions({ apiKey: "hf_test", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const byId = new Map(models?.map(model => [model.id, model]));

		expect(requests).toEqual(["https://router.huggingface.co/v1/models"]);
		// All upstreams explicitly non-tool-calling: a native `tools` param 400s.
		expect(byId.get("Qwen/Qwen2.5-Coder-3B-Instruct")?.supportsTools).toBe(false);
		// Mixed capability: at least one upstream can serve tools; never degrade.
		expect(byId.get("deepseek-ai/DeepSeek-V3.2")?.supportsTools).toBeUndefined();
		// Capability not advertised: keep the tool-capable default.
		expect(byId.get("meta-llama/Llama-3.3-70B-Instruct")?.supportsTools).toBeUndefined();
		expect(byId.get("no-providers/legacy-model")?.supportsTools).toBeUndefined();
	});
});
