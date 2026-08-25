import { countTokens as countTokensNat } from "@veyyon/natives";
import { estimateTokensFromText } from "@veyyon/utils";

const accurate = process.env.VEYYON_TOKENIZER_ACCURATE === "1" && Bun.env.NODE_ENV !== "test";

export function countTokens(text: string | string[]): number {
	if (accurate) {
		return countTokensNat(text);
	} else if (Array.isArray(text)) {
		let total = 0;
		for (const t of text) total += estimateTokensFromText(t);
		return total;
	} else {
		return estimateTokensFromText(text);
	}
}
