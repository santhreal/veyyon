import { musicbrainzDeclaration } from "./declarations/media";
import { createMediaHandler } from "./engine/media";
import type { SpecialHandler } from "./types";

export const handleMusicBrainz: SpecialHandler = createMediaHandler(musicbrainzDeclaration, "handleMusicBrainz");
