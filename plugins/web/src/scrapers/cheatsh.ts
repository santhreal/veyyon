import { cheatshDeclaration } from "./declarations/documentation";
import { createDocumentationHandler } from "./engine/documentation";
import type { SpecialHandler } from "./types";

export const handleCheatSh: SpecialHandler = createDocumentationHandler(cheatshDeclaration, "handleCheatSh");
