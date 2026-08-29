import { type } from "arktype";

export const learnSchema = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"skill?": type({
		action: "'create' | 'update'",
		name: type("string").describe("kebab-case skill name"),
		description: type("string").describe("one-line description of when to use the skill"),
		body: type("string").describe("the SKILL.md body in markdown (no frontmatter)"),
	}).describe("also create or enhance a managed skill in the same call"),
});

export type LearnParams = typeof learnSchema.infer;

/** Orchestrating "learn" tool: persists a lesson to long-term memory and, given a `skill` payload, mints/enhances a managed skill via the shared */
