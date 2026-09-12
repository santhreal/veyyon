import { orcidDeclaration } from "./declarations/academic-papers";
import { createAcademicPaperHandler } from "./engine/academic-paper";
import type { SpecialHandler } from "./types";

export const handleOrcid: SpecialHandler = createAcademicPaperHandler(orcidDeclaration, "handleOrcid");
