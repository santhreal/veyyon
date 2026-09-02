import { isDashscopeCompatibleModeUrl } from "@veyyon/catalog/hosts";
import { isQwenModelId } from "@veyyon/catalog/identity";

import type { Model } from "../types";

/**
 * Detect known text-only Qwen models served via Alibaba DashScope's consumer
 * `compatible-mode` endpoint that the upstream chat-completions API rejects
 * multimodal content arrays for. The compatible-mode endpoint also serves
 * multimodal Qwen SKUs without `vl` in the id (e.g. `qwen3.7-plus`), so this
 * guard only covers families verified to be text-only for issue #1859:
 * `qwen*-max` and `qwen*-coder*`.
 *
 * Used as a defensive override in `convertMessages` so a misconfigured custom
 * provider (issue #1859) can't drive the request into an unrecoverable 400.
 */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	if (!model.baseUrl || !isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	const id = model.id.toLowerCase();
	if (!isQwenModelId(model.id)) return false;
	return /\bqwen(?:[\d.]+)?-max\b/.test(id) || /\bqwen(?:[\d.]+)?-coder\b/.test(id);
}
