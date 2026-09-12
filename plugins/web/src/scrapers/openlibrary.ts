import { openlibraryDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleOpenLibrary: SpecialHandler = createDocumentationHandler(
	openlibraryDeclaration,
	"handleOpenLibrary",
);
