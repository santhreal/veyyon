import { readthedocsDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleReadTheDocs: SpecialHandler = createDocumentationHandler(
	readthedocsDeclaration,
	"handleReadTheDocs",
);
