import { discourseDeclaration } from "./declarations/discussions";
import { createDiscussionHandler } from "./engine/discussion";
import type { SpecialHandler } from "./types";

export const handleDiscourse: SpecialHandler = createDiscussionHandler(discourseDeclaration, "handleDiscourse");
