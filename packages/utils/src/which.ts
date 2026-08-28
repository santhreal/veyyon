import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type CacheKey = string | bigint | number;

const XCODE_BINS = new Set([
	"clang",
	"clang++",
	"gcc",
	"g++",
	"cc",
	"c++",
	"cpp",
	"c89",
	"c99",
	"swift",
	"swiftc",
	"swift-frontend",
	"clangd",
	"sourcekit-lsp",
	"ld",
	"ld-classic",
	"ar",
	"ranlib",
	"libtool",
	"as",
	"lipo",
	"install_name_tool",
	"codesign_allocate",
	"make",
	"gnumake",
	"m4",
	"flex",
	"bison",
	"yacc",
	"lex",
	"git",
	"git-receive-pack",
	"git-upload-pack",
	"git-upload-archive",
	"git-shell",
	"scalar",
	"lldb",
	"lldb-dap",
	"nm",
	"otool",
	"objdump",
	"strings",
	"strip",
	"size",
	"dsymutil",
	"dwarfdump",
	"lipo",
	"vtool",
	"clang-format",
	"swift-format",
]);

const XCODE_BIN_PREFIXES = ["python", "pip", "pydoc", "2to3"];

function isXcodeBin(command: string): boolean {
	if (XCODE_BINS.has(command)) return true;
	for (const prefix of XCODE_BIN_PREFIXES) {
		if (command.startsWith(prefix)) return true;
	}
	return false;
}

function getDeveloperDirs(): string | null {
	const envDir = process.env.DEVELOPER_DIR;
	if (envDir && fs.existsSync(envDir)) {
		return envDir;
	}

	try {
		return fs.readlinkSync("/var/db/xcode_select_link");
	} catch {}
	for (const candidate of ["/Applications/Xcode.app/Contents/Developer", "/Library/Developer/CommandLineTools"]) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

let macosToolPaths: Map<string, string> | undefined;
function getMacosToolPaths(): Map<string, string> {
	if (macosToolPaths) return macosToolPaths;
	const paths: string[] = ["/Library/Developer/CommandLineTools/usr/bin"];
	const devDir = getDeveloperDirs();
	if (devDir) {
		paths.push(path.join(devDir, "usr/bin"), path.join(devDir, "Toolchains/XcodeDefault.xctoolchain/usr/bin"));
	}

	macosToolPaths = new Map<string, string>();
	for (const dir of Array.from(new Set(paths))) {
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() || entry.isSymbolicLink()) {
					if (macosToolPaths.has(entry.name)) {
						continue;
					}
					macosToolPaths.set(entry.name, path.join(dir, entry.name));
				}
			}
		} catch {}
	}
	return macosToolPaths;
}

const toolCache = new Map<CacheKey, string | null>();

export const enum WhichCachePolicy {
	Cached = 0,
	Bypass,
	Fresh,
	ReadOnly,
}

export interface WhichOptions extends Bun.WhichOptions {
	cache?: WhichCachePolicy;
}

function darwinWhich(command: string, _options?: Bun.WhichOptions): string | null {
	const regular = Bun.which(command);
	if (regular) return regular;
	if (isXcodeBin(command)) {
		return getMacosToolPaths().get(command) ?? null;
	}
	return null;
}

export const whichFresh = os.platform() === "darwin" ? darwinWhich : Bun.which;

function cacheKey(command: string, options?: Bun.WhichOptions): CacheKey {
	if (!options) return command;
	if (!options.cwd && !options.PATH) return command;
	let h = Bun.hash(command);
	if (options.cwd) h = Bun.hash(options.cwd, h);
	if (options.PATH) h = Bun.hash(options.PATH, h);
	return h;
}

export function $which(command: string, options?: WhichOptions): string | null {
	const cachePolicy = options?.cache ?? WhichCachePolicy.Cached;
	let key: CacheKey | undefined;

	if (cachePolicy !== WhichCachePolicy.Bypass) {
		key = cacheKey(command, options);
		if (cachePolicy !== WhichCachePolicy.Fresh) {
			const cached = toolCache.get(key);
			if (cached !== undefined) return cached;
		}
	}

	const result = whichFresh(command, options);
	if (key != null && cachePolicy !== WhichCachePolicy.ReadOnly) {
		toolCache.set(key, result);
	}
	return result;
}
