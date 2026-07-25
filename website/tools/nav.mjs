/**
 * The site's navigation, in one place.
 *
 * The pages under `website/` are hand-authored HTML with no template engine, so
 * the header nav, the mobile disclosure nav, and the footer nav used to be twelve
 * hand-copied blocks across six files. They drifted exactly the way duplicated
 * code drifts: 404.html silently lost the Blog link, and the generated blog pages
 * never marked Blog as the current page. Both were invisible because nothing
 * compared the copies.
 *
 * So the links live here and `build.mjs` writes them into every page's
 * `<!--NAV:START-->` / `<!--NAV:END-->` region, the same way it writes the blog
 * region of `sitemap.xml`. Add a link once, in `LINKS`, and every surface gets it.
 * A page missing its markers is a hard build error, never a skipped page.
 */

/**
 * Every nav destination, in display order.
 *
 * - `href` is relative to the site root, without a leading `./`; the renderer adds
 *   the prefix a page needs (`./` at the root, `../` for `/blog/`).
 * - `absolute` links out and takes no prefix.
 * - `page` is the identity a page passes as `current` to get `aria-current="page"`.
 */
export const LINKS = [
	{ label: "Models", href: "models.html", page: "models" },
	{ label: "Features", href: "features.html", page: "features" },
	{ label: "Install", href: "install.html", page: "install" },
	{ label: "Changelog", href: "changelog.html", page: "changelog" },
	{ label: "Blog", href: "blog/", page: "blog" },
	{ label: "Docs", href: "docs/", page: "docs" },
	{ label: "GitHub", href: "https://github.com/santhreal/veyyon", absolute: true },
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
export function renderNav({ prefix, current, cta = true, indent = "      " }) {
	const lines = LINKS.map(link => {
		const href = link.absolute ? link.href : `${prefix}${link.href}`;
		// aria-current is what tells a screen reader (and the nav's own styling)
		// which page you are on. It is derived here so no page can forget it.
		const mark = current && link.page === current ? ' aria-current="page"' : "";
		return `${indent}<a href="${href}"${mark}>${link.label}</a>`;
	});
	if (cta) lines.push(`${indent}<a href="${prefix}${CTA.href}" class="btn">${CTA.label}</a>`);
	return lines.join("\n");
}
