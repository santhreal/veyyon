import { discogsDeclaration } from "./declarations/media";
import { createMediaHandler } from "./engine/media";
import type { SpecialHandler } from "./types";

export const handleDiscogs: SpecialHandler = createMediaHandler(discogsDeclaration, "handleDiscogs");
