#!/usr/bin/env bun
import * as path from "node:path";
import { generateThemeVars, getTemplate } from "../src/export/html";

const outPath = process.argv[2];
if (!outPath) {
	console.error("usage: bun scripts/generate-share-viewer.ts <output.html>");
	process.exit(2);
}

const loaderJs = await Bun.file(new URL("../src/export/html/share-loader.js", import.meta.url).pathname).text();
const themeVars = await generateThemeVars("web");

const html = getTemplate()
	.replace("<theme-vars/>", () => `<style>:root { ${themeVars} }</style>`)
	.replace("<title>Session Export</title>", () => "<title>veyyon session</title>")
	.replace("{{SESSION_DATA}}</script>", () => `</script>\n  <script>${loaderJs}</script>`);

if (html.includes("{{SESSION_DATA}}")) throw new Error("session-data placeholder survived substitution");
if (!html.includes("__OMP_SESSION_DATA__")) throw new Error("share loader not injected");

await Bun.write(outPath, html);
console.log(`Generated ${path.resolve(outPath)} (${(html.length / 1024).toFixed(0)} KB)`);
