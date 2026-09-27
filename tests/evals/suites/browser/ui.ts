/**
 * The HTML shell every application of the browser suite renders its pages in.
 *
 * Pages are server-rendered with small inline scripts, as most production sites still are: what an
 * agent reads is markup, and what it changes goes through forms and fetches the server records.
 */

import { escapeHtml } from "../../engine/kit/web-host";

const BASE_STYLE = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:#1d232b;background:#f5f6f8}
header.app{display:flex;gap:16px;align-items:center;padding:10px 20px;background:#1f2937;color:#fff}
header.app a{color:#e5e7eb;text-decoration:none}
header.app .brand{font-weight:700;font-size:16px;color:#fff}
main{max-width:1080px;margin:0 auto;padding:20px}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:14px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.muted{color:#6b7280}
.error{color:#b91c1c}
.notice{background:#ecfdf5;border:1px solid #a7f3d0;padding:8px 12px;border-radius:6px;margin-bottom:12px}
button,.button{background:#2563eb;color:#fff;border:0;border-radius:4px;padding:6px 12px;cursor:pointer;font:inherit}
button.secondary,.button.secondary{background:#e5e7eb;color:#111827}
button:disabled{opacity:.45;cursor:not-allowed}
input,select,textarea{font:inherit;padding:5px 7px;border:1px solid #cbd5e1;border-radius:4px}
label{display:block;margin:6px 0 2px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:50}
.dialog{background:#fff;border-radius:8px;padding:20px;min-width:320px;max-width:460px}
`;

export interface PageOptions {
	/** The header's links, as ready markup. */
	readonly nav?: string;
	readonly brand?: string;
	/** Extra CSS for this page. */
	readonly style?: string;
	/** Inline script run at the end of the body. */
	readonly script?: string;
}

export function page(title: string, body: string, options: PageOptions = {}): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}${options.style ?? ""}</style>
</head>
<body>
<header class="app"><span class="brand">${escapeHtml(options.brand ?? "")}</span>${options.nav ?? ""}</header>
<main>
${body}
</main>
${options.script ? `<script>${options.script}</script>` : ""}
</body>
</html>`;
}

/** `$12.34` from cents. */
export function money(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
