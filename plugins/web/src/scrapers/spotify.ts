import { spotifyDeclaration } from "./declarations/media";
import { createMediaHandler } from "./engine/media";
import type { SpecialHandler } from "./types";

export const handleSpotify: SpecialHandler = createMediaHandler(spotifyDeclaration, "handleSpotify");
