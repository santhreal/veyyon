import { redditDeclaration } from "./declarations/discussions";
import { createDiscussionHandler } from "./engine/discussion";
import type { SpecialHandler } from "./types";

export const handleReddit: SpecialHandler = createDiscussionHandler(redditDeclaration, "handleReddit");
