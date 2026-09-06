/**
 * Formatting helpers for the launch card and status line before session resolution.
 */

import { settings } from "../../config/settings-instance";
import { readLaunchFacts } from "../launch-facts";

/**
 * What the card prints for the model before a catalog exists to name it.
 *
 * The display name recorded for this model, in whatever project it was last used in, and failing
 * that the configured role reduced to its final path segment. A role is stored qualified —
 * `nous-research/z-ai/glm-5.1` — and printing it whole costs the row the segments that trail it,
 * the context gauge first: at eighty columns that one id is twenty-six of them, so a row with no
 * recorded name drew no gauge and then grew one when the session resolved a display name. The tail
 * is the part a display name is derived from anyway, so the row states a narrower form of the same
 * fact rather than a different fact.
 *
 * A `:` or `@` suffix is left attached. It carries a thinking level, an upstream route or an Ollama
 * tag, telling them apart needs the resolver this path may not load, and the tail is short with
 * them on. Empty when no default role is configured, which is the one case where the card has
 * nothing to state and says so.
 */
export function launchModelLabel(): string {
	const { modelName } = readLaunchFacts();
	if (modelName) return modelName;
	const role = settings.getModelRole("default");
	if (!role) return "";
	return role.slice(role.lastIndexOf("/") + 1);
}

/**
 * The provider the configured default role names, parsed from the role itself.
 *
 * A role is stored `provider/id`, and a provider id never contains a slash, so
 * the first segment is the provider. This is the card's cold answer for the
 * hero's provider: the session records it per model, but a machine's first
 * launch of a model has no recording, and the role already states the fact for
 * free. Empty when no role is configured or the role carries no provider.
 */
export function launchProviderLabel(): string {
	const role = settings.getModelRole("default");
	if (!role) return "";
	const slash = role.indexOf("/");
	return slash > 0 ? role.slice(0, slash) : "";
}
