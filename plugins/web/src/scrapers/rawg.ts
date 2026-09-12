import { rawgDeclaration } from "./declarations/media";
import { createMediaHandler } from "./engine/media";
import type { SpecialHandler } from "./types";

export const handleRawg: SpecialHandler = createMediaHandler(rawgDeclaration, "handleRawg");
