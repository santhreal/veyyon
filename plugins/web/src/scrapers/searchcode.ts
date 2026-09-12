import { searchcodeDeclaration } from "./declarations/business";
import { createBusinessHandler } from "./engine/business";
import type { SpecialHandler } from "./types";

export const handleSearchcode: SpecialHandler = createBusinessHandler(searchcodeDeclaration, "handleSearchcode");
