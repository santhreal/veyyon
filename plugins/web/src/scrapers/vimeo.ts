import { vimeoDeclaration } from "./declarations/media";
import { createMediaHandler } from "./engine/media";
import type { SpecialHandler } from "./types";

export const handleVimeo: SpecialHandler = createMediaHandler(vimeoDeclaration, "handleVimeo");
