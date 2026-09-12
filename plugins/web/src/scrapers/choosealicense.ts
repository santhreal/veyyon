import { choosealicenseDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleChooseALicense: SpecialHandler = createDocumentationHandler(
	choosealicenseDeclaration,
	"handleChooseALicense",
);
