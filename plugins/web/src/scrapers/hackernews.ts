import { decodeHNText, hackerNewsDeclaration } from "./declarations/discussions";
import { createDiscussionHandler } from "./engine/discussion";
import type { SpecialHandler } from "./types";

export { decodeHNText };
export const handleHackerNews: SpecialHandler = createDiscussionHandler(hackerNewsDeclaration, "handleHackerNews");
