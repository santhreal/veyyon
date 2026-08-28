export type GitSource = {
	type: "git";
	repo: string;
	host: string;
	path: string;
	ref?: string;
	pinned: boolean;
};

const KNOWN_HOSTS: Record<string, (pathname: string, hash: string) => { user: string; project: string } | null> = {
	"github.com": extractStandard,
	"gitlab.com": extractGitLab,
	"bitbucket.org": extractStandard,
	"git.sr.ht": extractStandard,
	"codeberg.org": extractStandard,
};

export const SHORTHAND_PREFIXES: Record<string, string> = {
	github: "github.com",
	gitlab: "gitlab.com",
	bitbucket: "bitbucket.org",
	codeberg: "codeberg.org",
	sourcehut: "git.sr.ht",
	srht: "git.sr.ht",
};

const SHORTHAND_RE = /^([a-z]+):([^/:#]+)\/([^#]+?)(?:\.git)?(?:#(.+))?$/i;

function stripUrlCredentials(url: string): string {
	if (!url.includes("://")) return url;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return url;
	}
}

function extractStandard(pathname: string, _hash: string): { user: string; project: string } | null {
	const [, user, project] = pathname.split("/", 3);
	if (!user || !project) return null;
	return { user, project: project.replace(/\.git$/, "") };
}

function extractGitLab(pathname: string, _hash: string): { user: string; project: string } | null {
	const path = pathname.startsWith("/") ? pathname.slice(1) : pathname;
	if (path.includes("/-/") || path.includes("/archive.tar.gz")) return null;
	const segments = path.split("/");
	let project = segments.pop();
	if (!project) return null;
	project = project.replace(/\.git$/, "");
	const user = segments.join("/");
	if (!user || !project) return null;
	return { user, project };
}

function tryKnownHost(candidate: string): { domain: string; user: string; project: string; committish: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return null;
	}

	const hostname = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : parsed.hostname;
	const extractor = KNOWN_HOSTS[hostname];
	if (!extractor) return null;

	const segments = extractor(parsed.pathname, parsed.hash);
	if (!segments) return null;

	let committish = "";
	if (parsed.hash) {
		try {
			committish = decodeURIComponent(parsed.hash.slice(1));
		} catch {
			return null;
		}
	}

	return {
		domain: hostname,
		user: segments.user,
		project: segments.project,
		committish,
	};
}

function splitRef(url: string): { repo: string; ref?: string } {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			if (parsed.protocol === "http:" || parsed.protocol === "https:") {
				parsed.username = "";
				parsed.password = "";
			}
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) return { repo: url };
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) return { repo: url };
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) return { repo: url };
	return { repo: `${host}/${repoPath}`, ref };
}

function tryKnownHostSource(
	split: { repo: string; ref?: string },
	candidate: string,
	repoUrl: string,
): GitSource | null {
	const info = tryKnownHost(candidate);
	if (!info) return null;
	if (split.ref && info.project.includes("@")) return null;
	return {
		type: "git",
		repo: stripUrlCredentials(repoUrl),
		host: info.domain,
		path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
		ref: info.committish || split.ref || undefined,
		pinned: Boolean(info.committish || split.ref),
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let repoPath = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		repoPath = scpLikeMatch[2] ?? "";
	} else if (/^https?:\/\/|^ssh:\/\/|^git:\/\//.test(repoWithoutRef)) {
		try {
			const parsed = new URL(repoWithoutRef);
			if (parsed.hash) {
				try {
					decodeURIComponent(parsed.hash.slice(1));
				} catch {
					return null;
				}
			}
			host = parsed.hostname;
			repoPath = parsed.pathname.replace(/^\/+/, "");
			repo = stripUrlCredentials(repoWithoutRef);
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) return null;
		repo = `https://${repoWithoutRef}`;
		try {
			const parsed = new URL(repo);
			host = parsed.hostname;
			repoPath = parsed.pathname.replace(/^\/+/, "");
			repo = stripUrlCredentials(repo);
		} catch {
			return null;
		}
		if (!host.includes(".") && host !== "localhost") return null;
	}

	const normalizedPath = repoPath.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !normalizedPath || normalizedPath.split("/").length < 2) return null;

	return { type: "git", repo, host, path: normalizedPath, ref, pinned: Boolean(ref) };
}

function tryNamespacedShorthand(trimmed: string): GitSource | null {
	if (!/^[a-z]+:[^/]/i.test(trimmed)) return null;
	const match = trimmed.match(SHORTHAND_RE);
	if (!match) return null;
	const prefix = (match[1] ?? "").toLowerCase();
	const host = SHORTHAND_PREFIXES[prefix];
	if (!host) return null;
	const user = match[2] ?? "";
	const repoPath = match[3] ?? "";
	if (!user || !repoPath) return null;
	const ref = match[4];
	if (ref) {
		try {
			decodeURIComponent(ref);
		} catch {
			return null;
		}
	}
	const fullPath = `${user}/${repoPath}`;
	return {
		type: "git",
		repo: `https://${host}/${fullPath}`,
		host,
		path: fullPath,
		ref: ref || undefined,
		pinned: Boolean(ref),
	};
}

export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();

	const shorthand = tryNamespacedShorthand(trimmed);
	if (shorthand) return shorthand;

	const stripped = /^git\+/i.test(trimmed) ? trimmed.slice(4) : trimmed;

	const hasGitPrefix = /^git:(?!\/\/)/i.test(stripped);
	const url = hasGitPrefix ? stripped.slice(4).trim() : stripped;

	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url) && !/^git@[^:]+:.+\/.+/i.test(url)) {
		return null;
	}

	const hashIndex = url.indexOf("#");
	if (hashIndex >= 0) {
		const hash = url.slice(hashIndex + 1);
		if (hash) {
			try {
				decodeURIComponent(hash);
			} catch {
				return null;
			}
		}
	}
	const split = splitRef(url);

	const scpMatch = split.repo.match(/^git@([^:]+):(.+)$/);

	const directCandidates: string[] = [];
	if (scpMatch) {
		directCandidates.push(`https://${scpMatch[1]}/${scpMatch[2]}`);
	} else if (/^https?:\/\/|^ssh:\/\/|^git:\/\//.test(split.repo)) {
		directCandidates.push(split.repo);
	}

	for (const candidate of directCandidates) {
		const withRef = split.ref ? `${candidate.replace(/#.*$/, "")}#${split.ref}` : candidate;
		const needsHttps =
			!split.repo.startsWith("http://") &&
			!split.repo.startsWith("https://") &&
			!split.repo.startsWith("ssh://") &&
			!split.repo.startsWith("git://") &&
			!split.repo.startsWith("git@");
		const result = tryKnownHostSource(split, withRef, needsHttps ? `https://${split.repo}` : split.repo);
		if (result) return result;
	}

	if (!split.repo.includes("://") && !split.repo.startsWith("git@")) {
		const httpsCandidate = split.ref ? `https://${split.repo}#${split.ref}` : `https://${url}`;
		const result = tryKnownHostSource(split, httpsCandidate, `https://${split.repo}`);
		if (result) return result;
	}

	return parseGenericGitUrl(url);
}

export function isGitSpec(spec: string): boolean {
	return parseGitUrl(spec) !== null;
}
