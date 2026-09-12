import * as fs from "node:fs/promises";

// Resolve a Chrome/Chromium binary. Walks the explicit path, PATH lookups via
// Bun.which, and well-known absolute locations; each candidate is confirmed
// with fs.stat so a directory or stale entry never wins.
export async function resolveChrome(explicit: string | undefined): Promise<string> {
  const candidates: string[] = [];
  const fromEnv = explicit ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
  if (fromEnv) candidates.push(fromEnv);
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) {
    const found = Bun.which(name);
    if (found) candidates.push(found);
  }
  candidates.push(
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not present — try the next candidate
    }
  }
  throw new Error("No Chrome/Chromium found. Pass --chrome <path> or set PUPPETEER_EXECUTABLE_PATH.");
}
