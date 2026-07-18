import { countTokens as countTokensNat } from "@veyyon/natives";
import { estimateTokensFromText } from "@veyyon/utils";

const accurate = process.env.VEYYON_TOKENIZER_ACCURATE === "1" && Bun.env.NODE_ENV !== "test";

export function countTokens(text: string | string[]): number {
	if (accurate) {
		return countTokensNat(text);
	} else if (Array.isArray(text)) {
		return text.reduce((sum, t) => sum + estimateTokensFromText(t), 0);
	} else {
		return estimateTokensFromText(text);
	}
}
