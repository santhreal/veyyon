import { secEdgarDeclaration } from "./declarations/business";
import { createBusinessHandler } from "./engine/business";
import type { SpecialHandler } from "./types";

export const handleSecEdgar: SpecialHandler = createBusinessHandler(secEdgarDeclaration, "handleSecEdgar");
