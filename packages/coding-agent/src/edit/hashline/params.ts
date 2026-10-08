/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required.
 */

import { type } from "@veyyon/ai/utils/schema/arktype";
import { lazy } from "@veyyon/utils/abortable";

export const hashlineEditParamsSchema = lazy(() =>
	type({
		input: "string",
	}),
);

export type HashlineParams = typeof hashlineEditParamsSchema.value.infer;
