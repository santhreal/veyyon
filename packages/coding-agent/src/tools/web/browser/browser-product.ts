/**
 * The product name and full version of a Chromium binary, read before the browser starts, because the
 * `--user-agent` launch flag has to carry the version the browser will report.
 *
 * On Linux and macOS, `<binary> --version` prints `<product name> <version>` and exits before any browser
 * starts (`HandleVersionSwitches` in chrome/app/chrome_main_delegate.cc). On Windows the binary is a GUI
 * program, so its version resource is read from the file instead: the same product name and version,
 * with no process started.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { errorMessage, logger } from "@veyyon/utils";
import type { BrowserProduct } from "./host-identity";

const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** `Google Chrome 152.0.7977.82 `, `Chromium 154.0.8037.57 built on Debian GNU/Linux 13 (trixie)`. */
export function parseVersionOutput(output: string): BrowserProduct | undefined {
	const match = output.match(/^\s*(.+?)\s+(\d+\.\d+\.\d+\.\d+)(?:\s|$)/m);
	if (!match) return undefined;
	return { name: match[1]!, version: match[2]! };
}

/** `VS_FIXEDFILEINFO.dwSignature`, little-endian. */
const FIXED_FILE_INFO_SIGNATURE = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
const PRODUCT_NAME_KEY = Buffer.from("ProductName\0", "utf16le");

/**
 * The product version (`dwProductVersionMS`/`LS` of `VS_FIXEDFILEINFO`) and the `ProductName` string of a
 * PE file's version resource.
 */
export function parseWindowsVersionResource(bytes: Buffer): BrowserProduct | undefined {
	const fixed = bytes.lastIndexOf(FIXED_FILE_INFO_SIGNATURE);
	if (fixed < 0 || fixed + 24 > bytes.length) return undefined;
	const productMs = bytes.readUInt32LE(fixed + 16);
	const productLs = bytes.readUInt32LE(fixed + 20);
	const version = `${productMs >>> 16}.${productMs & 0xffff}.${productLs >>> 16}.${productLs & 0xffff}`;
	const key = bytes.indexOf(PRODUCT_NAME_KEY, fixed);
	// A `String` entry is `wLength`, `wValueLength` (characters, terminator included), `wType`, the key,
	// padding to a 32-bit boundary, then the value.
	if (key < fixed + 6) return undefined;
	const valueChars = bytes.readUInt16LE(key - 4);
	const keyEnd = key + PRODUCT_NAME_KEY.length;
	const start = keyEnd + ((4 - (keyEnd % 4)) % 4);
	const end = Math.min(start + valueChars * 2, bytes.length);
	const name = bytes.toString("utf16le", start, end).replace(/\0+$/, "").trim();
	return name ? { name, version } : undefined;
}

async function probeVersionOutput(executablePath: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(executablePath, ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS }, (error, stdout) => {
		if (error) reject(error);
		else resolve(String(stdout));
	});
	return promise;
}

async function readProduct(executablePath: string): Promise<BrowserProduct | undefined> {
	try {
		const product =
			process.platform === "win32"
				? parseWindowsVersionResource(await fs.readFile(executablePath))
				: parseVersionOutput(await probeVersionOutput(executablePath));
		if (!product) logger.warn("The browser binary did not state its product and version", { executablePath });
		return product;
	} catch (error) {
		logger.warn("The browser binary's product and version could not be read", {
			executablePath,
			error: errorMessage(error),
		});
		return undefined;
	}
}

const products = new Map<string, Promise<BrowserProduct | undefined>>();

/**
 * The binary's product name and version, read once per binary: the cache key is the path and its
 * modification time, so an updated browser is read again. Undefined, with a warning, when the binary
 * does not say.
 */
export async function readBrowserProduct(executablePath: string): Promise<BrowserProduct | undefined> {
	let modified: number;
	try {
		modified = (await fs.stat(executablePath)).mtimeMs;
	} catch (error) {
		logger.warn("The browser binary's product and version could not be read", {
			executablePath,
			error: errorMessage(error),
		});
		return undefined;
	}
	const key = `${executablePath}\0${modified}`;
	let product = products.get(key);
	if (!product) {
		product = readProduct(executablePath);
		products.set(key, product);
	}
	return product;
}
