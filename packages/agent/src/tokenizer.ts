import { countTokens as countTokensNat } from "@veyyon/pi-natives";
import { estimateTextTokens } from "@veyyon/pi-utils";

const accurate = process.env.PI_TOKENIZER_ACCURATE === "1" && Bun.env.NODE_ENV !== "test";

export function countTokens(text: string | string[]): number {
	if (accurate) {
		return countTokensNat(text);
	} else if (Array.isArray(text)) {
		return text.reduce((sum, t) => sum + estimateTextTokens(t), 0);
	} else {
		return estimateTextTokens(text);
	}
}
