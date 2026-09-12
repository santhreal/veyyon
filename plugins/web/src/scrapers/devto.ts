import { devtoDeclaration } from "./declarations/discussions";
import { createDiscussionHandler } from "./engine/discussion";
import type { SpecialHandler } from "./types";

export const handleDevTo: SpecialHandler = createDiscussionHandler(devtoDeclaration, "handleDevTo");
