import { lobstersDeclaration } from "./declarations/discussions";
import { createDiscussionHandler } from "./engine/discussion";
import type { SpecialHandler } from "./types";

export const handleLobsters: SpecialHandler = createDiscussionHandler(lobstersDeclaration, "handleLobsters");
