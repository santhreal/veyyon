import { modelFamilyToken } from "@veyyon/catalog/identity";

/** Resolves whether full tool descriptors should be inlined into the system prompt (and stripped from provider tool schemas) for a given model and */
export function shouldInlineToolDescriptors(
	setting: "auto" | "on" | "off" | undefined,
	modelId: string | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return modelId !== undefined && modelFamilyToken(modelId) === "gemini";
	}
}
