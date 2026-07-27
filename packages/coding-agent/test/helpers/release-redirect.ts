/**
 * The response `getLatestRelease` actually receives, for tests that stub `fetch`.
 *
 * The updater used to ask `api.github.com` and read `tag_name` out of a JSON
 * body. It asks `github.com/<repo>/releases/latest` now and reads the `Location`
 * header of the 302, because the API allows 60 requests an hour per IP and that
 * budget is shared by everyone behind the same address: an office or a CI fleet
 * running several agents spent it on startup checks alone. Every stub that used
 * to hand back `Response.json({ tag_name })` has to hand back a redirect
 * instead, and building that shape in one place keeps the next change to it from
 * having to be made in four files.
 */

/** The endpoint the updater resolves the newest version from. */
export const LATEST_RELEASE_URL = "https://github.com/santhreal/veyyon/releases/latest";

/** Where a redirect for `tag` points. Exported so tests can assert on it. */
export function releaseTagUrl(tag: string): string {
	return `https://github.com/santhreal/veyyon/releases/tag/${tag}`;
}

/**
 * A 302 to `tag`'s release page, the shape GitHub answers with.
 *
 * `status: 302` and a body of `null`, because the updater sends HEAD and reads
 * only the header. A `Response` object is single-use once its body is read, so
 * this is a factory rather than a constant: two calls in one test must not share
 * one response.
 */
export function releaseRedirect(tag: string): Response {
	return new Response(null, { status: 302, headers: { location: releaseTagUrl(tag) } });
}
