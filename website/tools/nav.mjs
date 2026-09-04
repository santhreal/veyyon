/**
 * The site's navigation, in one place.
 *
 * The pages under `website/` are hand-authored HTML with no template engine, so
 * the header nav, the mobile disclosure nav, and the footer nav used to be twelve
 * hand-copied blocks across six files. They drifted exactly the way duplicated
 * code drifts: a page silently lost a link, and a generated page never marked its
 * own section as current. Both were invisible because nothing compared the copies.
 *
 * So the links live here and `build.mjs` writes them into every page's
 * `<!--NAV:START-->` / `<!--NAV:END-->` region. Add a link once, in `LINKS`, and
 * every surface gets it. A page missing its markers is a hard build error, never a
 * skipped page.
 */

/**
 * Every nav destination, in display order.
 *
 * - `href` is relative to the site root, without a leading `./`; the renderer adds
 *   the prefix a page needs (`./` at the root, `../` one directory down).
 * - `absolute` links out and takes no prefix.
 * - `page` is the identity a page passes as `current` to get `aria-current="page"`.
 */
export const LINKS = [
	{ label: "Models", href: "models.html", page: "models" },
	{ label: "Features", href: "features.html", page: "features" },
	{ label: "Install", href: "install.html", page: "install" },
	{ label: "Changelog", href: "changelog.html", page: "changelog" },
	{ label: "Docs", href: "docs/", page: "docs" },
	{ label: "GitHub", href: "https://github.com/santhreal/veyyon", absolute: true, icon: "github" },
];

/** The call-to-action that closes the header navs (not the footer). */
export const CTA = { label: "Get started", href: "install.html" };

/**
 * Render one nav's inner HTML.
 *
 * @param {object} options
 * @param {string} options.prefix     Path prefix for site-relative links (`./` or `../`).
 * @param {string} [options.current]  `page` id of the page being rendered, for `aria-current`.
 * @param {boolean} [options.cta]     Append the Get-started button (header navs do, the footer does not).
 * @param {string} [options.indent]   Leading whitespace for each line, so the output matches the page's style.
 */
const GITHUB_ICON = '<svg class="nav-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

export function renderNav({ prefix, current, cta = true, indent = "      " }) {
	const lines = LINKS.map(link => {
		const href = link.absolute ? link.href : `${prefix}${link.href}`;
		const mark = current && link.page === current ? ' aria-current="page"' : "";
		const content = link.icon === "github" ? GITHUB_ICON : link.label;
		// An icon-only link renders no text and its glyph is aria-hidden, so the label has to
		// reach the accessible name some other way or the link is announced as its URL.
		const name = link.icon ? ` aria-label="${link.label}"` : "";
		return `${indent}<a href="${href}"${mark}${name}>${content}</a>`;
	});
	if (cta) lines.push(`${indent}<a href="${prefix}${CTA.href}" class="btn">${CTA.label}</a>`);
	return lines.join("\n");
}
