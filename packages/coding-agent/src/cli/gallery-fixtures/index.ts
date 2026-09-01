/** Aggregated sample data for the `veyyon gallery` command. Each fixture drives one tool's renderer through the four lifecycle states the */
import { agenticFixtures } from "./agentic";
import { codeintelFixtures } from "./codeintel";
import { editFixtures } from "./edit";
import { fsFixtures } from "./fs";
import { interactionFixtures } from "./interaction";
import { memoryFixtures } from "./memory";
import { miscFixtures } from "./misc";
import { searchFixtures } from "./search";
import { shellFixtures } from "./shell";
import { vibeFixtures } from "./vibe";
import { webFixtures } from "./web";

export * from "./types";

export const galleryFixtures = {
	...interactionFixtures,
	...shellFixtures,
	...fsFixtures,
	...searchFixtures,
	...editFixtures,
	...agenticFixtures,
	...memoryFixtures,
	...webFixtures,
	...codeintelFixtures,
	...miscFixtures,
	...vibeFixtures,
};
