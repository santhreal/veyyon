import { stackoverflowDeclaration } from "./declarations/discussions";
import { createDiscussionHandler } from "./engine/discussion";
import type { SpecialHandler } from "./types";

export const handleStackOverflow: SpecialHandler = createDiscussionHandler(
	stackoverflowDeclaration,
	"handleStackOverflow",
);
