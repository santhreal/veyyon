import { compareDottedNumeric, errorMessage, formatBytes, formatNumber, isCancellation, logger } from "@veyyon/utils";
import { escapeMarkdownTableCell } from "@veyyon/utils/markdown-table";
import { parseHTML } from "linkedom";
import { markdownLink } from "../../markdown-link";
import {
	renderDescriptionSection,
	renderHeader,
	renderReadme,
	renderSimpleList,
	renderStringList,
} from "../engine/markdown-assembly";
import type { PackageRegistryDeclaration } from "../engine/package-registry";
import type { LocalizedText } from "../types";
import { buildResult, formatIsoDate, getLocalizedText, htmlToBasicMarkdown, looksLikeHtml } from "../types";
import { finiteNumber, isRecord, trimmedString } from "../utils";

// ============================================================================
// 1. Artifact Hub
// ============================================================================

interface ArtifactHubMaintainer {
	name: string;
	email?: string;
}

interface ArtifactHubLink {
	name: string;
	url: string;
}

interface ArtifactHubRepository {
	name: string;
	display_name?: string;
	url: string;
	organization_name?: string;
	organization_display_name?: string;
}

interface ArtifactHubPackage {
	package_id: string;
	name: string;
	normalized_name: string;
	display_name?: string;
	description?: string;
	version: string;
	app_version?: string;
	license?: string;
	home_url?: string;
	readme?: string;
	install?: string;
	keywords?: string[];
	maintainers?: ArtifactHubMaintainer[];
	links?: ArtifactHubLink[];
	repository: ArtifactHubRepository;
	ts: number;
	created_at: number;
	stars?: number;
	official?: boolean;
	signed?: boolean;
	security_report_summary?: {
		low?: number;
		medium?: number;
		high?: number;
		critical?: number;
	};
	available_versions?: Array<{ version: string; ts: number }>;
}

const ARTIFACT_HUB_KIND_LABELS: Record<string, string> = {
	helm: "Helm Chart",
	"helm-plugin": "Helm Plugin",
	falco: "Falco Rules",
	opa: "OPA Policy",
	olm: "OLM Operator",
	tbaction: "Tinkerbell Action",
	krew: "Krew Plugin",
	tekton: "Tekton Task",
	"tekton-pipeline": "Tekton Pipeline",
	keda: "KEDA Scaler",
	coredns: "CoreDNS Plugin",
	keptn: "Keptn Integration",
	container: "Container Image",
	kubewarden: "Kubewarden Policy",
	gatekeeper: "Gatekeeper Policy",
	kyverno: "Kyverno Policy",
	"knative-client": "Knative Client Plugin",
	backstage: "Backstage Plugin",
	argo: "Argo Template",
	kubearmor: "KubeArmor Policy",
	kcl: "KCL Module",
	headlamp: "Headlamp Plugin",
	inspektor: "Inspektor Gadget",
	"meshery-design": "Meshery Design",
	"opencost-plugin": "OpenCost Plugin",
	radius: "Radius Recipe",
};

export const artifacthubDeclaration: PackageRegistryDeclaration = {
	site: "artifacthub",
	hosts: ["artifacthub.io", "www.artifacthub.io"],
	canonicalUrls: ["https://artifacthub.io/packages/helm/argo/argo-cd"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/packages\/([^/]+)\/([^/]+)\/([^/]+)/);
		if (!match) return null;
		return { name: `${match[1]}/${match[2]}/${match[3]}`, parsedUrl: parsed };
	},
	customFetch: async (match, ctx) => {
		const [kind, repo, name] = match.name.split("/");
		const apiUrl = `https://artifacthub.io/api/v1/packages/${kind}/${repo}/${name}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("artifacthub", ctx.loadFailure(result));

		const pkg = ctx.tryParseJson<ArtifactHubPackage>(result.content);
		if (!pkg) return ctx.scraperDegrade("artifacthub", "unexpected response shape");

		const displayName = pkg.display_name || pkg.name;
		const kindLabel = ARTIFACT_HUB_KIND_LABELS[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);

		let md = renderHeader(displayName, pkg.description);

		md += `**Type:** ${kindLabel} · **Version:** ${pkg.version}`;
		if (pkg.app_version) md += ` · **App Version:** ${pkg.app_version}`;
		if (pkg.license) md += ` · **License:** ${pkg.license}`;
		md += "\n";

		const badges: string[] = [];
		if (pkg.official) badges.push("Official");
		if (pkg.signed) badges.push("Signed");
		if (pkg.stars) badges.push(`${formatNumber(pkg.stars)} stars`);
		if (badges.length > 0) {
			md += `**${badges.join(" · ")}**\n`;
		}
		md += "\n";

		const repoDisplay =
			pkg.repository.organization_display_name || pkg.repository.display_name || pkg.repository.name;
		md += `**Repository:** ${repoDisplay}`;
		if (pkg.repository.url) {
			md += ` (${markdownLink(pkg.repository.url, pkg.repository.url)})`;
		}
		md += "\n";

		if (pkg.home_url) md += `**Homepage:** ${pkg.home_url}\n`;
		if (pkg.keywords?.length) md += `**Keywords:** ${pkg.keywords.join(", ")}\n`;
		if (pkg.maintainers?.length) {
			md += `**Maintainers:** ${pkg.maintainers.map(m => m.name).join(", ")}\n`;
		}

		if (pkg.security_report_summary) {
			const sec = pkg.security_report_summary;
			const parts: string[] = [];
			if (sec.critical) parts.push(`${sec.critical} critical`);
			if (sec.high) parts.push(`${sec.high} high`);
			if (sec.medium) parts.push(`${sec.medium} medium`);
			if (sec.low) parts.push(`${sec.low} low`);
			if (parts.length > 0) {
				md += `**Security:** ${parts.join(", ")}\n`;
			}
		}

		md += renderSimpleList("Links", pkg.links, link => markdownLink(link.name, link.url));

		if (pkg.install) {
			md += "\n## Installation\n\n```bash\n";
			md += `${pkg.install.trim()}\n`;
			md += "```\n";
		}

		md += renderSimpleList(
			"Recent Versions",
			pkg.available_versions,
			ver => `**${ver.version}** (${formatIsoDate(ver.ts * 1000)})`,
			5,
		);
		md += renderReadme(pkg.readme);

		return buildResult(md, {
			url: ctx.url,
			method: "artifacthub",
			fetchedAt: ctx.fetchedAt,
			notes: [`Fetched via Artifact Hub API (${kindLabel})`],
		});
	},
};

// ============================================================================
// 2. Arch User Repository (AUR)
// ============================================================================

interface AurPackage {
	Name: string;
	Version: string;
	Description?: string;
	Maintainer?: string;
	NumVotes: number;
	Popularity: number;
	Depends?: string[];
	MakeDepends?: string[];
	OptDepends?: string[];
	CheckDepends?: string[];
	LastModified: number;
	FirstSubmitted: number;
	URL?: string;
	URLPath?: string;
	PackageBase: string;
	OutOfDate?: number | null;
	License?: string[];
	Keywords?: string[];
	Conflicts?: string[];
	Provides?: string[];
	Replaces?: string[];
}

interface AurResponse {
	version: number;
	type: string;
	resultcount: number;
	results: AurPackage[];
}

export const aurDeclaration: PackageRegistryDeclaration = {
	site: "aur",
	hosts: ["aur.archlinux.org"],
	canonicalUrls: ["https://aur.archlinux.org/packages/yay"],
	pathPattern: /^\/packages\/([^/?#]+)/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const apiUrl = `https://aur.archlinux.org/rpc/?v=5&type=info&arg=${encodeURIComponent(packageName)}`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });

		if (!result.ok) return ctx.scraperDegrade("aur", ctx.loadFailure(result));

		const data = ctx.tryParseJson<AurResponse>(result.content);
		if (!data) return ctx.scraperDegrade("aur", "unexpected response shape");
		if (data.resultcount === 0 || !data.results[0]) return null;

		const pkg = data.results[0];

		let md = renderHeader(pkg.Name, pkg.Description);

		let verStr = pkg.Version;
		if (pkg.OutOfDate) {
			verStr += ` (flagged out-of-date: ${formatIsoDate(pkg.OutOfDate * 1000)})`;
		}
		md += `**Version:** ${verStr}\n`;

		if (pkg.Maintainer) {
			md += `**Maintainer:** ${markdownLink(pkg.Maintainer, `https://aur.archlinux.org/account/${pkg.Maintainer}`)}\n`;
		} else {
			md += "**Maintainer:** Orphaned\n";
		}

		md += `**Votes:** ${formatNumber(pkg.NumVotes)} · **Popularity:** ${pkg.Popularity.toFixed(2)}\n`;
		md += `**Last Updated:** ${formatIsoDate(pkg.LastModified * 1000)} · **First Submitted:** ${formatIsoDate(pkg.FirstSubmitted * 1000)}\n`;

		if (pkg.License?.length) md += `**License:** ${pkg.License.join(", ")}\n`;
		if (pkg.URL) md += `**Upstream:** ${pkg.URL}\n`;
		if (pkg.Keywords?.length) md += `**Keywords:** ${pkg.Keywords.join(", ")}\n`;

		md += renderStringList("Dependencies", pkg.Depends, true);
		md += renderStringList("Make Dependencies", pkg.MakeDepends, true);
		md += renderStringList("Optional Dependencies", pkg.OptDepends);
		md += renderStringList("Check Dependencies", pkg.CheckDepends);
		md += renderStringList("Provides", pkg.Provides);
		md += renderStringList("Conflicts", pkg.Conflicts);
		md += renderStringList("Replaces", pkg.Replaces);

		md += `\n---\n\n## Installation\n\n\`\`\`bash\n# Using an AUR helper (e.g., yay, paru)\nyay -S ${pkg.Name}\n\n# Manual installation\ngit clone https://aur.archlinux.org/${pkg.PackageBase}.git\ncd ${pkg.PackageBase}\nmakepkg -si\n\`\`\`\n`;

		return buildResult(md, {
			url: ctx.url,
			method: "aur",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via AUR RPC API"],
		});
	},
};

// ============================================================================
// 3. Homebrew
// ============================================================================

interface BrewFormula {
	name: string;
	full_name?: string;
	desc?: string;
	homepage?: string;
	license?: string;
	versions?: {
		stable?: string;
		head?: string;
		bottle?: boolean;
	};
	dependencies?: string[];
	build_dependencies?: string[];
	optional_dependencies?: string[];
	conflicts_with?: string[];
	caveats?: string;
	analytics?: {
		install?: {
			"30d"?: Record<string, number>;
			"90d"?: Record<string, number>;
			"365d"?: Record<string, number>;
		};
	};
}

interface BrewCask {
	token: string;
	name?: string[];
	desc?: string;
	homepage?: string;
	version?: string;
	sha256?: string;
	caveats?: string;
	depends_on?: {
		macos?: Record<string, string[]>;
	};
	conflicts_with?: {
		cask?: string[];
	};
	analytics?: {
		install?: {
			"30d"?: Record<string, number>;
			"90d"?: Record<string, number>;
			"365d"?: Record<string, number>;
		};
	};
}

function getBrewInstallCount(analytics?: { install?: { "30d"?: Record<string, number> } }): number | null {
	if (!analytics?.install?.["30d"]) return null;
	const counts = Object.values(analytics.install["30d"]);
	return counts.reduce((sum, n) => sum + n, 0);
}

export const brewDeclaration: PackageRegistryDeclaration = {
	site: "brew",
	hosts: ["formulae.brew.sh"],
	canonicalUrls: ["https://formulae.brew.sh/formula/ripgrep", "https://formulae.brew.sh/cask/visual-studio-code"],
	match: parsed => {
		const formulaMatch = parsed.pathname.match(/^\/formula\/([^/]+)\/?$/);
		const caskMatch = parsed.pathname.match(/^\/cask\/([^/]+)\/?$/);
		if (!formulaMatch && !caskMatch) return null;
		const isFormula = Boolean(formulaMatch);
		const name = decodeURIComponent(isFormula ? formulaMatch![1] : caskMatch![1]);
		return { name: `${isFormula ? "formula" : "cask"}/${name}`, parsedUrl: parsed };
	},
	customFetch: async (match, ctx) => {
		const [type, name] = match.name.split("/");
		const isFormula = type === "formula";
		const apiUrl = isFormula
			? `https://formulae.brew.sh/api/formula/${encodeURIComponent(name)}.json`
			: `https://formulae.brew.sh/api/cask/${encodeURIComponent(name)}.json`;

		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok) return ctx.scraperDegrade("brew", ctx.loadFailure(result));

		let md: string;

		if (isFormula) {
			const formula = ctx.tryParseJson<BrewFormula>(result.content);
			if (!formula) return ctx.scraperDegrade("brew", "unexpected response shape");
			md = renderHeader(formula.full_name || formula.name, formula.desc);
			md += `**Version:** ${formula.versions?.stable || "unknown"}`;
			if (formula.license) md += ` · **License:** ${formula.license}`;
			md += "\n";

			const installs = getBrewInstallCount(formula.analytics);
			if (installs !== null) {
				md += `**Installs (30d):** ${formatNumber(installs)}\n`;
			}
			md += "\n";

			md += `\`\`\`bash\nbrew install ${formula.name}\n\`\`\`\n\n`;

			if (formula.homepage) md += `**Homepage:** ${formula.homepage}\n`;
			md += renderStringList("Dependencies", formula.dependencies);
			md += renderStringList("Build Dependencies", formula.build_dependencies);
			md += renderStringList("Conflicts With", formula.conflicts_with);
			md += renderDescriptionSection(formula.caveats, "Caveats");
		} else {
			const cask = ctx.tryParseJson<BrewCask>(result.content);
			if (!cask) return ctx.scraperDegrade("brew", "unexpected response shape");

			md = renderHeader(cask.name?.[0] || cask.token, cask.desc);
			md += `**Version:** ${cask.version || "unknown"}\n`;

			const installs = getBrewInstallCount(cask.analytics);
			if (installs !== null) {
				md += `**Installs (30d):** ${formatNumber(installs)}\n`;
			}
			md += "\n";

			md += `\`\`\`bash\nbrew install --cask ${cask.token}\n\`\`\`\n\n`;

			if (cask.homepage) md += `**Homepage:** ${cask.homepage}\n`;
			md += renderStringList("Conflicts With", cask.conflicts_with?.cask);
			md += renderDescriptionSection(cask.caveats, "Caveats");
		}
		return buildResult(md, {
			url: ctx.url,
			method: "brew",
			fetchedAt: ctx.fetchedAt,
			notes: [`Fetched via Homebrew ${isFormula ? "formula" : "cask"} API`],
		});
	},
};

// ============================================================================
// 4. Chocolatey
// ============================================================================

interface NuGetODataEntry {
	Id: string;
	Version: string;
	Title?: string;
	Description?: string;
	Summary?: string;
	Authors?: string;
	ProjectUrl?: string;
	PackageSourceUrl?: string;
	Tags?: string;
	DownloadCount?: number;
	VersionDownloadCount?: number;
	Published?: string;
	LicenseUrl?: string;
	ReleaseNotes?: string;
	Dependencies?: string;
}

interface NuGetODataResponse {
	d?: {
		results?: NuGetODataEntry[];
	};
}

function extractXmlField(xml: string, fieldName: string): string | null {
	const pattern = new RegExp(`<d:${fieldName}[^>]*>([\\s\\S]*?)</d:${fieldName}>`, "i");
	const match = xml.match(pattern);
	if (!match) return null;
	return match[1].trim();
}

export const chocolateyDeclaration: PackageRegistryDeclaration = {
	site: "chocolatey",
	hosts: ["community.chocolatey.org", "chocolatey.org"],
	canonicalUrls: ["https://community.chocolatey.org/packages/git"],
	pathPattern: /^\/packages\/([^/]+)(?:\/([^/]+))?/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const specificVersion = match.version;

		let apiUrl = `https://community.chocolatey.org/api/v2/Packages()?$filter=Id%20eq%20'${encodeURIComponent(packageName)}'`;
		if (specificVersion) {
			apiUrl += `%20and%20Version%20eq%20'${encodeURIComponent(specificVersion)}'`;
		} else {
			apiUrl += "&$orderby=Version%20desc&$top=1";
		}

		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: { Accept: "application/atom+xml, application/xml" },
		});

		if (!result.ok) return ctx.scraperDegrade("chocolatey", ctx.loadFailure(result));

		let pkg = (() => {
			const data = ctx.tryParseJson<NuGetODataResponse>(result.content);
			return data?.d?.results?.[0] ?? null;
		})();

		if (!pkg) {
			const xmlId = extractXmlField(result.content, "Id");
			if (!xmlId) return ctx.scraperDegrade("chocolatey", "unexpected response shape");

			pkg = {
				Id: xmlId,
				Version: extractXmlField(result.content, "Version") || "",
				Title: extractXmlField(result.content, "Title") || undefined,
				Description: extractXmlField(result.content, "Description") || undefined,
				Summary: extractXmlField(result.content, "Summary") || undefined,
				Authors: extractXmlField(result.content, "Authors") || undefined,
				ProjectUrl: extractXmlField(result.content, "ProjectUrl") || undefined,
				PackageSourceUrl: extractXmlField(result.content, "PackageSourceUrl") || undefined,
				Tags: extractXmlField(result.content, "Tags") || undefined,
				DownloadCount: (() => {
					const value = extractXmlField(result.content, "DownloadCount");
					return value ? Number.parseInt(value, 10) : undefined;
				})(),
				VersionDownloadCount: (() => {
					const value = extractXmlField(result.content, "VersionDownloadCount");
					return value ? Number.parseInt(value, 10) : undefined;
				})(),
				Published: extractXmlField(result.content, "Published") || undefined,
				LicenseUrl: extractXmlField(result.content, "LicenseUrl") || undefined,
				ReleaseNotes: extractXmlField(result.content, "ReleaseNotes") || undefined,
				Dependencies: extractXmlField(result.content, "Dependencies") || undefined,
			};
		}

		let md = renderHeader(pkg.Title || pkg.Id);
		if (pkg.Summary) {
			md += `${pkg.Summary}\n\n`;
		} else if (pkg.Description) {
			md += `${pkg.Description.split(/\n\n/)[0]}\n\n`;
		}
		md += `**Version:** ${pkg.Version}`;
		if (pkg.Authors) md += ` · **Authors:** ${pkg.Authors}`;
		md += "\n";

		if (pkg.DownloadCount !== undefined) {
			md += `**Total Downloads:** ${formatNumber(pkg.DownloadCount)}`;
			if (pkg.VersionDownloadCount !== undefined) {
				md += ` · **Version Downloads:** ${formatNumber(pkg.VersionDownloadCount)}`;
			}
			md += "\n";
		}

		if (pkg.Published) {
			const published = formatIsoDate(pkg.Published);
			if (published) md += `**Published:** ${published}\n`;
		}
		md += "\n";

		if (pkg.ProjectUrl) md += `**Project URL:** ${pkg.ProjectUrl}\n`;
		if (pkg.PackageSourceUrl) md += `**Source:** ${pkg.PackageSourceUrl}\n`;
		if (pkg.LicenseUrl) md += `**License:** ${pkg.LicenseUrl}\n`;

		if (pkg.Tags) {
			const tags = pkg.Tags.split(/\s+/).filter(Boolean);
			if (tags.length > 0) {
				md += `**Tags:** ${tags.join(", ")}\n`;
			}
		}

		if (pkg.Description && pkg.Description !== pkg.Summary) {
			md += `\n## Description\n\n${pkg.Description}\n`;
		}
		md += renderDescriptionSection(pkg.ReleaseNotes, "Release Notes");

		if (pkg.Dependencies) {
			const deps = pkg.Dependencies.split("|").filter(d => d.trim().length > 0);
			if (deps.length > 0) {
				md += "\n## Dependencies\n\n";
				for (const dep of deps) {
					const [depId, depVersion] = dep.split(":");
					if (depId) {
						md += `- ${depId}${depVersion ? `: ${depVersion}` : ""}\n`;
					}
				}
			}
		}

		md += `\n---\n**Install:** \`choco install ${packageName}\`\n`;

		return buildResult(md, {
			url: ctx.url,
			method: "chocolatey",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Chocolatey NuGet API"],
		});
	},
};

// ============================================================================
// 5. Clojars
// ============================================================================

function formatClojarsLicenses(licenses: unknown): string[] {
	if (!Array.isArray(licenses)) return [];
	const output: string[] = [];
	for (const license of licenses) {
		if (typeof license === "string") {
			const trimmed = license.trim();
			if (trimmed) output.push(trimmed);
			continue;
		}
		if (isRecord(license)) {
			const name = trimmedString(license.name);
			const url = trimmedString(license.url);
			if (name && url) {
				output.push(`${name} (${url})`);
			} else if (name) {
				output.push(name);
			} else if (url) {
				output.push(url);
			}
		}
	}
	return output;
}

function formatClojarsDependencies(deps: unknown): string[] {
	const output: string[] = [];
	if (Array.isArray(deps)) {
		for (const dep of deps) {
			if (typeof dep === "string") {
				const trimmed = dep.trim();
				if (trimmed) output.push(trimmed);
				continue;
			}
			if (Array.isArray(dep)) {
				const name = trimmedString(dep[0]);
				const version = trimmedString(dep[1]);
				if (name && version) {
					output.push(`${name}: ${version}`);
				} else if (name) {
					output.push(name);
				}
				continue;
			}
			if (isRecord(dep)) {
				const name = trimmedString(dep.name) ?? trimmedString(dep.artifact) ?? trimmedString(dep.jar_name);
				const version = trimmedString(dep.version);
				if (name && version) {
					output.push(`${name}: ${version}`);
				} else if (name) {
					output.push(name);
				}
			}
		}
		return output;
	}

	if (isRecord(deps)) {
		for (const [name, version] of Object.entries(deps)) {
			const versionText = trimmedString(version);
			if (versionText) {
				output.push(`${name}: ${versionText}`);
			} else if (name.trim()) {
				output.push(name);
			}
		}
	}

	return output;
}

export const clojarsDeclaration: PackageRegistryDeclaration = {
	site: "clojars",
	hosts: ["clojars.org", "www.clojars.org"],
	canonicalUrls: ["https://clojars.org/org.clojure/clojure"],
	match: parsed => {
		const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
		if (!path) return null;
		const segments = path.split("/").filter(Boolean);
		if (segments.length < 1 || segments.length > 2) return null;
		return { name: path, parsedUrl: parsed };
	},
	customFetch: async (match, ctx) => {
		const segments = match.name.split("/").filter(Boolean);
		const groupFromUrl = segments.length === 2 ? decodeURIComponent(segments[0]) : null;
		const artifactFromUrl = decodeURIComponent(segments[segments.length - 1]);

		const apiUrl =
			segments.length === 2
				? `https://clojars.org/api/artifacts/${encodeURIComponent(groupFromUrl ?? "")}/${encodeURIComponent(artifactFromUrl)}`
				: `https://clojars.org/api/artifacts/${encodeURIComponent(artifactFromUrl)}`;

		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("clojars", ctx.loadFailure(result));

		const payload = ctx.tryParseJson(result.content);
		if (!payload) return null;

		const data = Array.isArray(payload) ? payload[0] : payload;
		if (!isRecord(data)) return null;

		const groupName = trimmedString(data.group_name) ?? trimmedString(data.group) ?? groupFromUrl;
		const artifactName =
			trimmedString(data.jar_name) ?? trimmedString(data.artifact) ?? trimmedString(data.name) ?? artifactFromUrl;
		const version = trimmedString(data.latest_version) ?? trimmedString(data.version);
		const description = trimmedString(data.description) ?? trimmedString(data.summary);
		const downloads =
			finiteNumber(data.downloads) ??
			finiteNumber(data.downloads_total) ??
			finiteNumber(data.total_downloads) ??
			null;
		const homepage = trimmedString(data.homepage) ?? trimmedString(data.url);
		const licenses = formatClojarsLicenses(data.licenses);
		const dependencies = formatClojarsDependencies(data.dependencies ?? data.deps);

		const displayName =
			groupName && artifactName && groupName !== artifactName
				? `${groupName}/${artifactName}`
				: (artifactName ?? groupName ?? "Clojars artifact");

		let md = renderHeader(displayName, description);
		if (groupName) md += `**Group:** ${groupName}\n`;
		if (artifactName) md += `**Artifact:** ${artifactName}\n`;
		if (version) md += `**Latest:** ${version}\n`;
		if (downloads !== null) md += `**Downloads:** ${formatNumber(downloads)}\n`;
		if (homepage) md += `**Homepage:** ${homepage}\n`;
		if (licenses.length > 0) md += `**Licenses:** ${licenses.join(", ")}\n`;
		md += renderStringList("Dependencies", dependencies);

		return buildResult(md, {
			url: ctx.url,
			method: "clojars",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Clojars API"],
		});
	},
};

// ============================================================================
// 6. Crates.io
// ============================================================================

export const cratesIoDeclaration: PackageRegistryDeclaration = {
	site: "crates-io",
	method: "crates.io",
	hosts: ["crates.io", "www.crates.io"],
	canonicalUrls: ["https://crates.io/crates/serde"],
	pathPattern: /^\/crates\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const crateName = match.name;
		const apiUrl = `https://crates.io/api/v1/crates/${crateName}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: { "User-Agent": "veyyon-web-fetch/1.0 (https://github.com/santhreal/veyyon)" },
		});

		if (!result.ok) return ctx.scraperDegrade("crates-io", ctx.loadFailure(result));

		const data = ctx.tryParseJson<{
			crate: {
				name: string;
				description: string | null;
				downloads: number;
				recent_downloads: number;
				max_version: string;
				repository: string | null;
				homepage: string | null;
				documentation: string | null;
				categories: string[];
				keywords: string[];
				created_at: string;
				updated_at: string;
			};
			versions?: Array<{
				num: string;
				downloads: number;
				created_at: string;
				license: string | null;
				rust_version: string | null;
			}>;
		}>(result.content);
		if (!data) return ctx.scraperDegrade("crates-io", "unexpected response shape");

		const crate = data.crate;
		const latestVersion = data.versions?.[0];

		let md = renderHeader(crate.name, crate.description);
		md += `**Latest:** ${crate.max_version}`;
		if (latestVersion?.license) md += ` · **License:** ${latestVersion.license}`;
		if (latestVersion?.rust_version) md += ` · **MSRV:** ${latestVersion.rust_version}`;
		md += "\n";

		md += `**Downloads:** ${formatNumber(crate.downloads)} total · ${formatNumber(crate.recent_downloads)} recent\n\n`;

		if (crate.repository) md += `**Repository:** ${crate.repository}\n`;
		if (crate.homepage && crate.homepage !== crate.repository) md += `**Homepage:** ${crate.homepage}\n`;
		if (crate.documentation) md += `**Docs:** ${crate.documentation}\n`;
		if (crate.keywords?.length) md += `**Keywords:** ${crate.keywords.join(", ")}\n`;
		if (crate.categories?.length) md += `**Categories:** ${crate.categories.join(", ")}\n`;

		md += renderSimpleList(
			"Recent Versions",
			data.versions,
			ver => `**${ver.num}** (${ver.created_at.split("T")[0]}) - ${formatNumber(ver.downloads)} downloads`,
			5,
		);

		const docsRsUrl = `https://docs.rs/crate/${crateName}/${crate.max_version}/source/README.md`;
		const readmeResult = await ctx.loadPage(docsRsUrl, { timeout: Math.min(ctx.timeout, 5), signal: ctx.signal });
		if (readmeResult.ok && readmeResult.content.length > 100 && !looksLikeHtml(readmeResult.content)) {
			md += renderReadme(readmeResult.content);
		}

		return buildResult(md, {
			url: ctx.url,
			method: "crates.io",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via crates.io API"],
		});
	},
};

// ============================================================================
// 7. Docker Hub
// ============================================================================

interface DockerHubRepo {
	name: string;
	namespace: string;
	description?: string;
	star_count?: number;
	pull_count?: number;
	last_updated?: string;
	is_official?: boolean;
	is_automated?: boolean;
	user?: string;
}

interface DockerHubTag {
	name: string;
	last_updated?: string;
	full_size?: number;
	digest?: string;
	images?: Array<{
		architecture?: string;
		os?: string;
		size?: number;
	}>;
}

interface DockerHubTagsResponse {
	results?: DockerHubTag[];
}

export const dockerhubDeclaration: PackageRegistryDeclaration = {
	site: "dockerhub",
	method: "dockerhub",
	hosts: ["hub.docker.com"],
	canonicalUrls: ["https://hub.docker.com/r/library/nginx", "https://hub.docker.com/_/nginx"],
	match: parsed => {
		const officialMatch = parsed.pathname.match(/^\/_\/([^/]+)/);
		if (officialMatch) {
			return { name: `library/${officialMatch[1]}`, parsedUrl: parsed };
		}
		const repoMatch = parsed.pathname.match(/^\/r\/([^/]+)\/([^/]+)/);
		if (!repoMatch) return null;
		return { name: `${repoMatch[1]}/${repoMatch[2]}`, parsedUrl: parsed };
	},
	customFetch: async (match, ctx) => {
		const [namespace, repository] = match.name.split("/");
		const repoUrl = `https://hub.docker.com/v2/repositories/${namespace}/${repository}/`;
		const tagsUrl = `https://hub.docker.com/v2/repositories/${namespace}/${repository}/tags/?page_size=10`;

		const [repoResult, tagsResult] = await Promise.all([
			ctx.loadPage(repoUrl, { timeout: ctx.timeout, headers: { Accept: "application/json" }, signal: ctx.signal }),
			ctx.loadPage(tagsUrl, {
				timeout: Math.min(ctx.timeout, 10),
				headers: { Accept: "application/json" },
				signal: ctx.signal,
			}),
		]);

		if (!repoResult.ok) return ctx.scraperDegrade("dockerhub", ctx.loadFailure(repoResult));

		const repo = ctx.tryParseJson<DockerHubRepo>(repoResult.content);
		if (!repo) return ctx.scraperDegrade("dockerhub", "unexpected response shape");

		let tags: DockerHubTag[] = [];
		if (tagsResult.ok) {
			const tagsData = ctx.tryParseJson<DockerHubTagsResponse>(tagsResult.content);
			if (tagsData?.results) tags = tagsData.results;
		}
		const fullName = namespace === "library" ? repo.name : `${namespace}/${repo.name}`;
		let md = renderHeader(fullName, repo.description);

		const stats: string[] = [];
		if (repo.pull_count !== undefined) stats.push(`**Pulls:** ${formatNumber(repo.pull_count)}`);
		if (repo.star_count !== undefined) stats.push(`**Stars:** ${formatNumber(repo.star_count)}`);
		if (repo.is_official) stats.push("**Official Image**");
		if (repo.is_automated) stats.push("**Automated Build**");
		if (stats.length > 0) {
			md += `${stats.join(" · ")}\n`;
		}

		if (repo.last_updated) {
			md += `**Last Updated:** ${formatIsoDate(repo.last_updated)}\n`;
		}
		md += "\n";

		md += `## Quick Start\n\n\`\`\`bash\ndocker pull ${fullName}\n\`\`\`\n\n`;

		if (tags.length > 0) {
			md += "## Recent Tags\n\n";
			md += "| Tag | Size | Architectures | Updated |\n";
			md += "|-----|------|---------------|--------|\n";

			for (const tag of tags) {
				const size = tag.full_size ? formatBytes(tag.full_size) : "-";
				const archs = escapeMarkdownTableCell(
					tag.images
						?.map(img => img.architecture)
						.filter(Boolean)
						.join(", ") || "-",
				);
				const updated = tag.last_updated ? formatIsoDate(tag.last_updated) : "-";
				md += `| \`${escapeMarkdownTableCell(tag.name)}\` | ${size} | ${archs} | ${updated} |\n`;
			}
			md += "\n";
		}

		return buildResult(md, {
			url: ctx.url,
			method: "dockerhub",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Docker Hub API"],
		});
	},
};

// ============================================================================
// 8. F-Droid
// ============================================================================

type FdroidPackage = {
	packageName?: string;
	name?: LocalizedText;
	summary?: LocalizedText;
	description?: LocalizedText;
	author?: string | { name?: string; email?: string };
	authorName?: string;
	authorEmail?: string;
	license?: string;
	categories?: string[];
	antiFeatures?: string[];
	sourceCode?: string;
	packages?: Array<{
		versionName?: string;
		versionCode?: number;
		added?: number;
		antiFeatures?: string[];
	}>;
	suggestedVersionCode?: number;
	suggestedVersionName?: string;
};

function normalizeFdroidAuthor(data: FdroidPackage): string | undefined {
	if (data.authorName) return data.authorName;
	if (typeof data.author === "string") return data.author;
	if (data.author && typeof data.author !== "string" && typeof data.author.name === "string") return data.author.name;
	if (data.authorEmail) return data.authorEmail;
	return undefined;
}

function normalizeFdroidAuthorEmail(data: FdroidPackage): string | undefined {
	if (data.authorEmail) return data.authorEmail;
	if (data.author && typeof data.author !== "string" && typeof data.author.email === "string")
		return data.author.email;
	return undefined;
}

function collectFdroidAntiFeatures(data: FdroidPackage): string[] {
	const values = new Set<string>();
	for (const feature of data.antiFeatures ?? []) values.add(feature);
	for (const pkg of data.packages ?? []) {
		for (const feature of pkg.antiFeatures ?? []) values.add(feature);
	}
	return Array.from(values);
}

function resolveFdroidSuggestedVersion(data: FdroidPackage): string | undefined {
	if (data.suggestedVersionName) return data.suggestedVersionName;
	if (data.suggestedVersionCode) {
		const match = data.packages?.find(pkg => pkg.versionCode === data.suggestedVersionCode);
		if (match?.versionName) return match.versionName;
	}
	return data.packages?.[0]?.versionName;
}

export const fdroidDeclaration: PackageRegistryDeclaration = {
	site: "fdroid",
	hosts: ["f-droid.org", "www.f-droid.org"],
	canonicalUrls: ["https://f-droid.org/packages/org.mozilla.fennec_fdroid/"],
	pathPattern: /^\/(?:en\/)?packages\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const apiUrl = `https://f-droid.org/api/v1/packages/${encodeURIComponent(packageName)}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("fdroid", ctx.loadFailure(result));

		const data = ctx.tryParseJson<FdroidPackage>(result.content);
		if (!data) return ctx.scraperDegrade("fdroid", "unexpected response shape");

		const displayName = getLocalizedText(data.name) ?? packageName;
		const summary = getLocalizedText(data.summary);
		const description = getLocalizedText(data.description);
		const author = normalizeFdroidAuthor(data);
		const authorEmail = normalizeFdroidAuthorEmail(data);
		const antiFeatures = collectFdroidAntiFeatures(data);
		const latestVersion = resolveFdroidSuggestedVersion(data);

		let md = renderHeader(displayName, summary);
		md += `**Package:** ${packageName}`;
		if (latestVersion) md += ` · **Latest:** ${latestVersion}`;
		if (data.license) md += ` · **License:** ${data.license}`;
		md += "\n";

		if (author) {
			md += `**Author:** ${author}${authorEmail && authorEmail !== author ? ` <${authorEmail}>` : ""}\n`;
		}

		if (data.sourceCode) md += `**Source Code:** ${data.sourceCode}\n`;
		if (data.categories?.length) md += `**Categories:** ${data.categories.join(", ")}\n`;
		if (antiFeatures.length > 0) md += `**Anti-Features:** ${antiFeatures.join(", ")}\n`;
		md += renderDescriptionSection(description);

		md += renderSimpleList(
			"Version History",
			data.packages,
			v => `${v.versionName ?? "unknown"}${v.versionCode ? ` (${v.versionCode})` : ""}`,
			10,
		);

		return buildResult(md, {
			url: ctx.url,
			method: "fdroid",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via F-Droid API"],
		});
	},
};

// ============================================================================
// 9. Firefox Add-ons (AMO)
// ============================================================================

type AddonFile = {
	permissions?: string[];
	host_permissions?: string[];
	optional_permissions?: string[];
	optional_host_permissions?: string[];
};

type AddonLicense = {
	name?: LocalizedText;
	slug?: string;
	url?: string;
};

type AddonVersion = {
	version?: string;
	license?: AddonLicense;
	file?: AddonFile;
};

type AddonHomepage = {
	url?: LocalizedText;
	outgoing?: LocalizedText;
};

type AddonData = {
	name?: LocalizedText;
	summary?: LocalizedText;
	description?: LocalizedText;
	default_locale?: string;
	authors?: Array<{ name?: string | null }>;
	average_daily_users?: number;
	weekly_downloads?: number;
	ratings?: { average?: number; count?: number };
	current_version?: AddonVersion;
	categories?: string[] | Record<string, string[]>;
	homepage?: AddonHomepage;
	url?: string;
};

function normalizeFirefoxCategories(categories?: string[] | Record<string, string[]>): string[] {
	if (!categories) return [];
	if (Array.isArray(categories)) return categories.filter(Boolean);

	const values: string[] = [];
	for (const list of Object.values(categories)) {
		if (Array.isArray(list)) {
			for (const item of list) {
				if (item) values.push(item);
			}
		}
	}

	const seen = new Set<string>();
	return values.filter(item => {
		if (seen.has(item)) return false;
		seen.add(item);
		return true;
	});
}

function collectFirefoxPermissions(file?: AddonFile): string[] {
	if (!file) return [];
	const permissions: string[] = [];
	const seen = new Set<string>();

	const add = (items?: string[]) => {
		for (const item of items ?? []) {
			if (!item || seen.has(item)) continue;
			seen.add(item);
			permissions.push(item);
		}
	};

	add(file.permissions);
	add(file.host_permissions);
	add(file.optional_permissions);
	add(file.optional_host_permissions);

	return permissions;
}

export const firefoxAddonsDeclaration: PackageRegistryDeclaration = {
	site: "firefox-addons",
	hosts: ["addons.mozilla.org"],
	canonicalUrls: ["https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/"],
	match: parsed => {
		const segments = parsed.pathname.split("/").filter(Boolean);
		const addonIndex = segments.indexOf("addon");
		if (addonIndex === -1) return null;
		const slug = segments[addonIndex + 1] ? decodeURIComponent(segments[addonIndex + 1]) : "";
		return slug ? { name: slug, parsedUrl: parsed } : null;
	},
	customFetch: async (match, ctx) => {
		const slug = match.name;
		const apiUrl = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(slug)}/`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});
		if (!result.ok) return ctx.scraperDegrade("firefox-addons", ctx.loadFailure(result));

		const data = ctx.tryParseJson<AddonData>(result.content);
		if (!data) return ctx.scraperDegrade("firefox-addons", "unexpected response shape");
		const defaultLocale = data.default_locale || "en-US";

		const name = getLocalizedText(data.name, defaultLocale) ?? slug;
		const summary = getLocalizedText(data.summary, defaultLocale);
		const descriptionRaw = getLocalizedText(data.description, defaultLocale);
		const description = descriptionRaw ? await htmlToBasicMarkdown(descriptionRaw) : undefined;

		const authors = (data.authors ?? [])
			.map(author => author.name ?? "")
			.map(author => author.trim())
			.filter(Boolean);

		const ratingAverage = data.ratings?.average;
		const ratingCount = data.ratings?.count;
		const users = data.average_daily_users ?? data.weekly_downloads;
		const version = data.current_version?.version;
		const categories = normalizeFirefoxCategories(data.categories);

		const licenseName =
			getLocalizedText(data.current_version?.license?.name, defaultLocale) ?? data.current_version?.license?.slug;
		const licenseUrl = data.current_version?.license?.url;

		const homepage =
			getLocalizedText(data.homepage?.url, defaultLocale) ??
			getLocalizedText(data.homepage?.outgoing, defaultLocale);

		const permissions = collectFirefoxPermissions(data.current_version?.file);

		let md = renderHeader(name, summary);

		if (authors.length > 0) {
			const label = authors.length > 1 ? "Authors" : "Author";
			md += `**${label}:** ${authors.join(", ")}\n`;
		}

		if (ratingAverage !== undefined) {
			md += `**Rating:** ${ratingAverage.toFixed(2)}`;
			if (ratingCount !== undefined) {
				md += ` (${formatNumber(ratingCount)} reviews)`;
			}
			md += "\n";
		}

		if (users !== undefined) md += `**Users:** ${formatNumber(users)}\n`;
		if (version) md += `**Version:** ${version}\n`;
		if (categories.length > 0) md += `**Categories:** ${categories.join(", ")}\n`;

		if (licenseName && licenseUrl) {
			md += `**License:** ${markdownLink(licenseName, licenseUrl)}\n`;
		} else if (licenseName) {
			md += `**License:** ${licenseName}\n`;
		} else if (licenseUrl) {
			md += `**License:** ${licenseUrl}\n`;
		}

		if (homepage) md += `**Homepage:** ${homepage}\n`;
		md += renderDescriptionSection(description);
		if (permissions.length > 0) {
			const count = Math.min(permissions.length, 40);
			md += `\n## Permissions (${permissions.length})\n\n`;
			for (let index = 0; index < count; index++) {
				md += `- ${permissions[index]}\n`;
			}
			if (permissions.length > count) {
				md += `\n[…${permissions.length - count} permissions elided…]\n`;
			}
		}

		const finalUrl = data.url ?? result.finalUrl ?? ctx.url;
		return buildResult(md, {
			url: ctx.url,
			finalUrl,
			method: "firefox-addons",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Firefox Add-ons API"],
		});
	},
};

// ============================================================================
// 10. Flathub
// ============================================================================

interface FlathubScreenshotSize {
	src?: string;
	width?: string;
	height?: string;
	scale?: string;
}

interface FlathubScreenshot {
	caption?: string | null;
	sizes?: FlathubScreenshotSize[];
}

interface FlathubRelease {
	version?: string;
	timestamp?: string;
	description?: string | null;
	url?: string | null;
	type?: string | null;
}

interface FlathubAppStream {
	id?: string;
	name?: string;
	summary?: string;
	description?: string;
	developer_name?: string;
	categories?: string[];
	screenshots?: FlathubScreenshot[];
	releases?: FlathubRelease[];
	metadata?: Record<string, unknown>;
	installs?: number | string;
	permissions?: unknown;
}

function parseFlathubNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const cleaned = value.replace(/[^0-9.]/g, "");
		if (!cleaned) return null;
		const parsed = Number(cleaned);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return null;
}

function normalizeFlathubStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	}
	if (typeof value === "string") {
		return value
			.split(/[,;\n]+/)
			.map(item => item.trim())
			.filter(Boolean);
	}
	return [];
}

function extractFlathubInstalls(app: FlathubAppStream): number | null {
	const direct = parseFlathubNumber(app.installs);
	if (direct !== null) return direct;

	if (!app.metadata) return null;
	for (const [key, value] of Object.entries(app.metadata)) {
		if (!key.toLowerCase().includes("install")) continue;
		const parsed = parseFlathubNumber(value);
		if (parsed !== null) return parsed;
	}

	return null;
}

function extractFlathubPermissions(app: FlathubAppStream): string[] {
	const permissions: string[] = [];
	permissions.push(...normalizeFlathubStringList(app.permissions));

	if (app.metadata) {
		for (const [key, value] of Object.entries(app.metadata)) {
			if (!key.toLowerCase().includes("permission")) continue;
			const list = normalizeFlathubStringList(value);
			if (list.length) {
				permissions.push(...list);
				continue;
			}
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				permissions.push(`${key}: ${String(value)}`);
			}
		}
	}

	return Array.from(new Set(permissions));
}

function flathubScreenshotArea(size?: FlathubScreenshotSize): number {
	if (!size) return 0;
	const width = Number(size.width);
	const height = Number(size.height);
	if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
	return width * height;
}

function bestFlathubScreenshotUrl(sizes?: FlathubScreenshotSize[]): string | null {
	if (!sizes || sizes.length === 0) return null;

	let best = sizes[0];
	let bestArea = flathubScreenshotArea(best);

	for (const size of sizes) {
		const area = flathubScreenshotArea(size);
		if (area > bestArea) {
			best = size;
			bestArea = area;
		}
	}

	return best.src ?? sizes[0].src ?? null;
}

export const flathubDeclaration: PackageRegistryDeclaration = {
	site: "flathub",
	hosts: ["flathub.org", "www.flathub.org"],
	canonicalUrls: ["https://flathub.org/apps/org.gimp.GIMP"],
	match: parsed => {
		const detailsMatch = parsed.pathname.match(/^\/apps\/details\/([^/]+)\/?$/);
		if (detailsMatch) return { name: decodeURIComponent(detailsMatch[1]), parsedUrl: parsed };
		const appMatch = parsed.pathname.match(/^\/apps\/([^/]+)\/?$/);
		if (appMatch) return { name: decodeURIComponent(appMatch[1]), parsedUrl: parsed };
		return null;
	},
	customFetch: async (match, ctx) => {
		const appId = match.name;
		const apiUrl = `https://flathub.org/api/v2/appstream/${encodeURIComponent(appId)}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: { Accept: "application/json" },
		});
		if (!result.ok) return ctx.scraperDegrade("flathub", ctx.loadFailure(result));

		const app = ctx.tryParseJson<FlathubAppStream>(result.content);
		if (!app) return ctx.scraperDegrade("flathub", "unexpected response shape");
		const name = app.name ?? app.id ?? appId;

		let md = renderHeader(name, app.summary);
		md += "## Metadata\n\n";
		md += `**App ID:** ${app.id ?? appId}\n`;
		if (app.developer_name) md += `**Developer:** ${app.developer_name}\n`;

		const installs = extractFlathubInstalls(app);
		if (installs !== null) md += `**Installs:** ${formatNumber(installs)}\n`;

		md += renderStringList("Categories", app.categories);

		if (app.description) {
			const description = await htmlToBasicMarkdown(app.description);
			md += renderDescriptionSection(description);
		}

		const permissions = extractFlathubPermissions(app);
		md += renderStringList("Permissions", permissions);

		if (app.screenshots?.length) {
			md += "\n## Screenshots\n\n";
			for (const screenshot of app.screenshots.slice(0, 5)) {
				const screenshotUrl = bestFlathubScreenshotUrl(screenshot.sizes);
				if (!screenshotUrl) continue;
				const caption = screenshot.caption ? ` - ${screenshot.caption}` : "";
				md += `- ${screenshotUrl}${caption}\n`;
			}
		}

		if (app.releases?.length) {
			md += "\n## Releases\n\n";
			for (const release of app.releases.slice(0, 5)) {
				const version = release.version ?? "unknown";
				let line = `- **${version}**`;
				const date = release.timestamp ? formatIsoDate(Number(release.timestamp) * 1000) : "";
				if (date) line += ` (${date})`;
				if (release.type) line += ` · ${release.type}`;
				if (release.url) line += ` · ${release.url}`;
				md += `${line}\n`;

				if (release.description) {
					const releaseDesc = (await htmlToBasicMarkdown(release.description)).replace(/\n+/g, " ").trim();
					if (releaseDesc) md += `  - ${releaseDesc}\n`;
				}
			}
		}

		return buildResult(md, {
			url: ctx.url,
			finalUrl: result.finalUrl,
			method: "flathub-appstream",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Flathub Appstream API"],
		});
	},
};

// ============================================================================
// 11. Go Package (pkg.go.dev)
// ============================================================================

interface GoModuleInfo {
	Version: string;
	Time: string;
}

export const goPkgDeclaration: PackageRegistryDeclaration = {
	site: "go-pkg",
	hosts: ["pkg.go.dev"],
	canonicalUrls: ["https://pkg.go.dev/github.com/gin-gonic/gin"],
	match: parsed => {
		const pathname = parsed.pathname.slice(1);
		return pathname ? { name: pathname, parsedUrl: parsed } : null;
	},
	customFetch: async (match, ctx) => {
		const pathname = match.name;
		let modulePath: string;
		let version = "latest";

		const atIndex = pathname.indexOf("@");
		if (atIndex !== -1) {
			const beforeAt = pathname.slice(0, atIndex);
			const afterAt = pathname.slice(atIndex + 1);

			const slashIndex = afterAt.indexOf("/");
			if (slashIndex !== -1) {
				version = afterAt.slice(0, slashIndex);
				modulePath = beforeAt;
			} else {
				version = afterAt;
				modulePath = beforeAt;
			}
		} else {
			modulePath = pathname;
		}

		const notes: string[] = [];
		const sections: string[] = [];

		let moduleInfo: GoModuleInfo | null = null;
		let actualModulePath = modulePath;

		if (version === "latest") {
			try {
				const proxyUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@latest`;
				const proxyResult = await ctx.loadPage(proxyUrl, { timeout: ctx.timeout, signal: ctx.signal });

				if (proxyResult.ok) {
					moduleInfo = ctx.tryParseJson<GoModuleInfo>(proxyResult.content);
					if (moduleInfo) {
						version = moduleInfo.Version;
					}
				}
			} catch {
				// Proxy lookup failed, fallback to page
			}
		} else {
			try {
				const proxyUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@v/${encodeURIComponent(version)}.info`;
				const proxyResult = await ctx.loadPage(proxyUrl, { timeout: ctx.timeout, signal: ctx.signal });

				if (proxyResult.ok) {
					moduleInfo = ctx.tryParseJson<GoModuleInfo>(proxyResult.content);
				}
			} catch {
				// Proxy lookup failed
			}
		}
		const pageResult = await ctx.loadPage(ctx.url, { timeout: ctx.timeout, signal: ctx.signal });
		if (!pageResult.ok) return ctx.scraperDegrade("go-pkg", ctx.loadFailure(pageResult));

		const doc = parseHTML(pageResult.content).document;

		const breadcrumb = doc.querySelector(".go-Breadcrumb");
		if (breadcrumb) {
			const moduleLink = breadcrumb.querySelector("a[href^='/']");
			if (moduleLink) {
				const href = moduleLink.getAttribute("href");
				if (href) {
					actualModulePath = href.slice(1).split("@")[0];
				}
			}
		}

		if (!moduleInfo) {
			const versionBadge = doc.querySelector(".go-Chip");
			if (versionBadge) {
				const versionText = versionBadge.textContent?.trim();
				if (versionText?.startsWith("v")) {
					version = versionText;
				}
			}
		}

		const licenseLink = doc.querySelector("a[data-test-id='UnitHeader-license']");
		const license = licenseLink?.textContent?.trim() || "Unknown";

		const importPathInput = doc.querySelector("input[data-test-id='UnitHeader-importPath']");
		const importPath = importPathInput?.getAttribute("value") || actualModulePath;

		sections.push(`# ${importPath}`);
		sections.push("");
		sections.push(`**Module:** ${actualModulePath}`);
		sections.push(`**Version:** ${version}`);
		sections.push(`**License:** ${license}`);
		sections.push("");

		const synopsis = doc.querySelector(".go-Main-headerContent p");
		if (synopsis) {
			const synopsisText = synopsis.textContent?.trim();
			if (synopsisText) {
				sections.push(`## Synopsis`);
				sections.push("");
				sections.push(synopsisText);
				sections.push("");
			}
		}

		const docSection = doc.querySelector("#section-documentation");
		if (docSection) {
			sections.push("## Documentation");
			sections.push("");

			const overview = docSection.querySelector(".go-Message");
			if (overview) {
				const overviewMd = await htmlToBasicMarkdown(overview.innerHTML);
				sections.push(overviewMd);
				sections.push("");
			}

			const docContent = docSection.querySelector(".Documentation-content");
			if (docContent) {
				const paragraphs = docContent.querySelectorAll("p");
				const docParts: string[] = [];
				for (let i = 0; i < Math.min(3, paragraphs.length); i++) {
					const p = paragraphs[i];
					const text = (await htmlToBasicMarkdown(p.innerHTML)).trim();
					if (text) {
						docParts.push(text);
					}
				}

				if (docParts.length > 0) {
					sections.push(docParts.join("\n\n"));
					sections.push("");
				}
			}
		}

		const indexSection = doc.querySelector("#section-index");
		if (indexSection) {
			const indexList = indexSection.querySelector(".Documentation-indexList");
			if (indexList) {
				sections.push("## Index");
				sections.push("");

				const items = indexList.querySelectorAll("li");
				const exported: string[] = [];

				for (const item of items) {
					const link = item.querySelector("a");
					if (link) {
						const name = link.textContent?.trim();
						if (name) {
							exported.push(`- ${name}`);
						}
					}
				}

				if (exported.length > 0) {
					sections.push(exported.slice(0, 50).join("\n"));
					if (exported.length > 50) {
						notes.push(`showing 50 of ${exported.length} exports`);
						sections.push(`\n[…${exported.length - 50} exports elided…]`);
					}
					sections.push("");
				}
			}
		}

		const importsSection = doc.querySelector("#section-imports");
		if (importsSection) {
			const importsList = importsSection.querySelector(".go-Message");
			if (importsList) {
				sections.push("## Imports");
				sections.push("");

				const links = importsList.querySelectorAll("a");
				const imports: string[] = [];

				for (const link of links) {
					const imp = link.textContent?.trim();
					if (imp) {
						imports.push(`- ${imp}`);
					}
				}

				if (imports.length > 0) {
					sections.push(imports.slice(0, 20).join("\n"));
					if (imports.length > 20) {
						notes.push(`showing 20 of ${imports.length} imports`);
						sections.push(`\n[…${imports.length - 20} imports elided…]`);
					}
					sections.push("");
				}
			}
		}

		if (moduleInfo) {
			notes.push(`published ${moduleInfo.Time}`);
		}

		const content = sections.join("\n");

		return buildResult(content, {
			url: ctx.url,
			finalUrl: pageResult.finalUrl,
			method: "go-pkg",
			fetchedAt: ctx.fetchedAt,
			notes,
		});
	},
};

// ============================================================================
// 12. Hackage
// ============================================================================

interface HackageVersionMap {
	[version: string]: string;
}

interface ParsedCabal {
	name?: string;
	version?: string;
	synopsis?: string;
	description?: string;
	license?: string;
	author?: string;
	maintainer?: string;
	homepage?: string;
	bugReports?: string;
	category?: string;
	stability?: string;
}

function extractCabalField(content: string, fieldName: string): string | undefined {
	const pattern = new RegExp(`^${fieldName}:\\s*(.*)$`, "im");
	const match = content.match(pattern);
	if (!match) return undefined;
	return match[1].trim();
}

function extractCabalDescription(content: string): string | undefined {
	const lines = content.split("\n");
	const start = lines.findIndex(line => line.toLowerCase().startsWith("description:"));
	if (start < 0) return undefined;
	const value = lines[start].replace(/^description:\s*/i, "").trim();
	const chunks: string[] = [value];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith("  ")) break;
		chunks.push(line.trim());
	}
	const description = chunks.join("\n").trim();
	return description || undefined;
}

function parseCabal(content: string): ParsedCabal {
	return {
		name: extractCabalField(content, "name"),
		version: extractCabalField(content, "version"),
		synopsis: extractCabalField(content, "synopsis"),
		description: extractCabalDescription(content),
		license: extractCabalField(content, "license"),
		author: extractCabalField(content, "author"),
		maintainer: extractCabalField(content, "maintainer"),
		homepage: extractCabalField(content, "homepage"),
		bugReports: extractCabalField(content, "bug-reports"),
		category: extractCabalField(content, "category"),
		stability: extractCabalField(content, "stability"),
	};
}

export const hackageDeclaration: PackageRegistryDeclaration = {
	site: "hackage",
	hosts: ["hackage.haskell.org"],
	canonicalUrls: ["https://hackage.haskell.org/package/aeson"],
	pathPattern: /^\/package\/([^/]+)(?:\/|$)/,
	customFetch: async (match, ctx) => {
		const packageId = match.name;
		const versionUrl = `https://hackage.haskell.org/package/${encodeURIComponent(packageId)}.json`;
		const versionResult = await ctx.loadPage(versionUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!versionResult.ok) return ctx.scraperDegrade("hackage", ctx.loadFailure(versionResult));

		const versionMap = ctx.tryParseJson<HackageVersionMap>(versionResult.content);
		if (!versionMap) return ctx.scraperDegrade("hackage", "unexpected response shape");
		const latestVersion = Object.keys(versionMap).sort(compareDottedNumeric).at(-1);
		if (!latestVersion) return null;

		const cabalUrl = `https://hackage.haskell.org/package/${encodeURIComponent(packageId)}-${latestVersion}/${encodeURIComponent(packageId)}.cabal`;
		const cabalResult = await ctx.loadPage(cabalUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "text/plain" },
			signal: ctx.signal,
		});

		if (!cabalResult.ok) return ctx.scraperDegrade("hackage", ctx.loadFailure(cabalResult));

		const pkg = parseCabal(cabalResult.content);

		let md = renderHeader(pkg.name || packageId, pkg.synopsis);
		md += `**Version:** ${pkg.version || latestVersion}`;
		if (pkg.license) md += ` · **License:** ${pkg.license}`;
		md += "\n";

		if (pkg.author) md += `**Author:** ${pkg.author}\n`;
		if (pkg.maintainer) md += `**Maintainer:** ${pkg.maintainer}\n`;
		if (pkg.category) md += `**Category:** ${pkg.category}\n`;
		if (pkg.stability) md += `**Stability:** ${pkg.stability}\n`;
		if (pkg.homepage) md += `**Homepage:** ${pkg.homepage}\n`;
		if (pkg.bugReports) md += `**Bug Reports:** ${pkg.bugReports}\n`;
		md += renderDescriptionSection(pkg.description);

		return buildResult(md, {
			url: ctx.url,
			method: "hackage",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Hackage API"],
		});
	},
};

// ============================================================================
// 13. Hex.pm
// ============================================================================

export const hexDeclaration: PackageRegistryDeclaration = {
	site: "hex",
	hosts: ["hex.pm", "www.hex.pm"],
	canonicalUrls: ["https://hex.pm/packages/phoenix"],
	pathPattern: /^\/packages\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const apiUrl = `https://hex.pm/api/packages/${packageName}`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });

		if (!result.ok) return ctx.scraperDegrade("hex", ctx.loadFailure(result));

		const data = ctx.tryParseJson<{
			name: string;
			meta?: {
				description?: string;
				links?: Record<string, string>;
				licenses?: string[];
			};
			releases?: Array<{
				version: string;
				inserted_at: string;
			}>;
			downloads?: {
				all?: number;
				week?: number;
				day?: number;
			};
			latest_version?: string;
			latest_stable_version?: string;
		}>(result.content);
		if (!data) return ctx.scraperDegrade("hex", "unexpected response shape");

		let md = `# ${data.name}\n\n`;
		if (data.meta?.description) md += `${data.meta.description}\n\n`;

		const version = data.latest_stable_version || data.latest_version || "unknown";
		md += `**Latest:** ${version}`;
		if (data.meta?.licenses?.length) md += ` · **License:** ${data.meta.licenses.join(", ")}`;
		md += "\n";

		if (data.downloads?.all) {
			md += `**Total Downloads:** ${formatNumber(data.downloads.all)}`;
			if (data.downloads.week) md += ` · **This Week:** ${formatNumber(data.downloads.week)}`;
			md += "\n";
		}
		md += "\n";

		if (data.meta?.links && Object.keys(data.meta.links).length > 0) {
			md += `## Links\n\n`;
			for (const [key, value] of Object.entries(data.meta.links)) {
				md += `- **${key}:** ${value}\n`;
			}
			md += "\n";
		}

		if (data.releases?.length) {
			const releasesUrl = `https://hex.pm/api/packages/${packageName}/releases/${version}`;
			const releaseResult = await ctx.loadPage(releasesUrl, {
				timeout: Math.min(ctx.timeout, 5),
				signal: ctx.signal,
			});

			if (releaseResult.ok) {
				const releaseData = ctx.tryParseJson<{
					requirements?: Record<string, { app?: string; optional: boolean; requirement: string }>;
				}>(releaseResult.content);

				if (releaseData?.requirements && Object.keys(releaseData.requirements).length > 0) {
					md += `## Dependencies (${version})\n\n`;
					for (const [dep, info] of Object.entries(releaseData.requirements)) {
						const optional = info.optional ? " (optional)" : "";
						md += `- ${dep}: ${info.requirement}${optional}\n`;
					}
					md += "\n";
				}
			}

			const recentReleases = data.releases.slice(0, 10);
			if (recentReleases.length > 0) {
				md += `## Recent Releases\n\n`;
				for (const release of recentReleases) {
					const date = formatIsoDate(release.inserted_at);
					md += `- **${release.version}** (${date})\n`;
				}
			}
		}

		return buildResult(md, {
			url: ctx.url,
			method: "hex",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Hex.pm API"],
		});
	},
};

// ============================================================================
// 14. JetBrains Marketplace
// ============================================================================

interface PluginVendor {
	name?: string;
	publicName?: string;
	url?: string;
}

interface PluginTag {
	name?: string;
}

type PluginRating =
	| number
	| {
			rating?: number;
			value?: number;
			score?: number;
			votes?: number;
			totalVotes?: number;
			count?: number;
	  };

interface PluginData {
	id?: number;
	name?: string;
	description?: string;
	preview?: string;
	vendor?: PluginVendor;
	rating?: PluginRating;
	ratingCount?: number;
	downloads?: number;
	tags?: PluginTag[];
	urls?: {
		url?: string;
		docUrl?: string;
		sourceCodeUrl?: string;
		bugtrackerUrl?: string;
	};
}

interface UpdateData {
	version?: string;
	since?: string;
	until?: string;
	sinceUntil?: string;
	channel?: string;
	downloads?: number;
	compatibleVersions?: Record<string, string>;
	cdate?: string | number;
}

function extractJetBrainsRating(plugin: PluginData): { value: number | null; votes: number | null } {
	const rating = plugin.rating;
	if (typeof rating === "number" && Number.isFinite(rating)) {
		return { value: rating, votes: plugin.ratingCount ?? null };
	}
	if (rating && typeof rating === "object") {
		const value = rating.rating ?? rating.value ?? rating.score ?? null;
		const votes = rating.votes ?? rating.totalVotes ?? rating.count ?? plugin.ratingCount ?? null;
		return { value: typeof value === "number" ? value : null, votes: typeof votes === "number" ? votes : null };
	}
	return { value: null, votes: plugin.ratingCount ?? null };
}

function formatJetBrainsBuildCompatibility(update: UpdateData): string | null {
	if (update.sinceUntil) return update.sinceUntil;
	if (update.since && update.until) return `${update.since} - ${update.until}`;
	if (update.since) return `${update.since}+`;
	return null;
}

export const jetbrainsMarketplaceDeclaration: PackageRegistryDeclaration = {
	site: "jetbrains-marketplace",
	hosts: ["plugins.jetbrains.com"],
	canonicalUrls: ["https://plugins.jetbrains.com/plugin/1347-scala"],
	pathPattern: /^\/plugin\/(\d+)/,
	customFetch: async (match, ctx) => {
		const pluginId = match.name;
		const pluginUrl = `https://plugins.jetbrains.com/api/plugins/${pluginId}`;
		const updatesUrl = `https://plugins.jetbrains.com/api/plugins/${pluginId}/updates?size=1`;

		const [pluginResult, updatesResult] = await Promise.all([
			ctx.loadPage(pluginUrl, { timeout: ctx.timeout, signal: ctx.signal }),
			ctx.loadPage(updatesUrl, { timeout: ctx.timeout, signal: ctx.signal }),
		]);

		if (!pluginResult.ok || !updatesResult.ok) return null;

		const plugin = ctx.tryParseJson<PluginData>(pluginResult.content);
		const updates = ctx.tryParseJson<UpdateData[]>(updatesResult.content);
		if (!plugin || !updates) return null;

		const update = updates[0];
		if (!plugin?.name) return null;

		const vendorName = plugin.vendor?.name ?? plugin.vendor?.publicName;
		const descriptionSource = plugin.description ?? plugin.preview ?? "";
		const description = descriptionSource ? await htmlToBasicMarkdown(descriptionSource) : "";
		const tags = (plugin.tags ?? []).map(tag => tag.name).filter((name): name is string => Boolean(name));
		const rating = extractJetBrainsRating(plugin);
		const buildCompatibility = update ? formatJetBrainsBuildCompatibility(update) : null;

		let md = renderHeader(plugin.name, description);
		md += `**Plugin ID:** ${pluginId}\n`;
		if (vendorName) md += `**Vendor:** ${vendorName}\n`;
		if (plugin.downloads !== undefined) md += `**Downloads:** ${formatNumber(plugin.downloads)}\n`;

		if (rating.value !== null) {
			md += `**Rating:** ${rating.value.toFixed(2)}`;
			if (rating.votes !== null) md += ` (${formatNumber(rating.votes)} votes)`;
			md += "\n";
		}
		if (tags.length > 0) md += `**Tags:** ${tags.join(", ")}\n`;

		if (update) {
			md += "\n## Latest Release\n\n";
			if (update.version) md += `**Version:** ${update.version}\n`;
			if (update.channel) md += `**Channel:** ${update.channel}\n`;
			if (buildCompatibility) md += `**Build Compatibility:** ${buildCompatibility}\n`;
			if (update.downloads !== undefined) md += `**Release Downloads:** ${formatNumber(update.downloads)}\n`;
		}

		const compatibility = update?.compatibleVersions ?? {};
		const compatibilityEntries = Object.entries(compatibility).sort(([a], [b]) => a.localeCompare(b));
		md += renderSimpleList(
			"IDE Compatibility",
			compatibilityEntries,
			([product, version]) => `${product}: ${version}`,
		);

		return buildResult(md, {
			url: ctx.url,
			method: "jetbrains-marketplace",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via JetBrains Marketplace API"],
		});
	},
};

// ============================================================================
// 15. Maven Central
// ============================================================================

interface MavenDoc {
	id: string;
	g: string;
	a: string;
	latestVersion: string;
	repositoryId: string;
	p: string;
	timestamp: number;
	versionCount: number;
	text?: string[];
	ec?: string[];
}

interface MavenResponse {
	response: {
		numFound: number;
		docs: MavenDoc[];
	};
}

export const mavenDeclaration: PackageRegistryDeclaration = {
	site: "maven",
	hosts: ["search.maven.org", "mvnrepository.com", "www.mvnrepository.com", "central.sonatype.com"],
	canonicalUrls: ["https://search.maven.org/artifact/com.google.guava/guava"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
		if (!match) return null;
		const groupId = match[1];
		const artifactId = match[2];
		const version = match[3] || undefined;
		return { name: `${groupId}:${artifactId}`, version, parsedUrl: parsed };
	},
	customFetch: async (match, ctx) => {
		const [groupId, artifactId] = match.name.split(":");
		const version = match.version || null;

		const apiUrl = `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(groupId)}+AND+a:${encodeURIComponent(artifactId)}&wt=json&rows=1`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("maven", ctx.loadFailure(result));

		const data = ctx.tryParseJson<MavenResponse>(result.content);
		if (!data) return ctx.scraperDegrade("maven", "unexpected response shape");
		if (data.response.numFound === 0) return null;

		const doc = data.response.docs[0];
		const displayVersion = version || doc.latestVersion;

		let md = `# ${doc.g}:${doc.a}\n\n`;
		md += `**Group ID:** ${doc.g}\n`;
		md += `**Artifact ID:** ${doc.a}\n`;
		md += `**Latest Version:** ${doc.latestVersion}`;
		if (version && version !== doc.latestVersion) {
			md += ` (viewing ${version})`;
		}
		md += "\n";

		if (doc.p) md += `**Packaging:** ${doc.p}\n`;
		if (doc.versionCount) md += `**Versions:** ${formatNumber(doc.versionCount)}\n`;
		if (doc.timestamp) md += `**Last Updated:** ${formatIsoDate(doc.timestamp)}\n`;

		md += `\n## Maven Dependency\n\n\`\`\`xml\n<dependency>\n    <groupId>${doc.g}</groupId>\n    <artifactId>${doc.a}</artifactId>\n    <version>${displayVersion}</version>\n</dependency>\n\`\`\`\n`;
		md += `\n## Gradle Dependency\n\n\`\`\`groovy\nimplementation '${doc.g}:${doc.a}:${displayVersion}'\n\`\`\`\n`;
		md += `\n## Gradle (Kotlin DSL)\n\n\`\`\`kotlin\nimplementation("${doc.g}:${doc.a}:${displayVersion}")\n\`\`\`\n`;

		const extensions = doc.ec?.filter(e => e && e !== "-");
		md += renderStringList("Available Extensions", extensions);

		md += "\n## Links\n\n";
		md += `- [Maven Central](https://search.maven.org/artifact/${doc.g}/${doc.a}/${displayVersion}/jar)\n`;
		md += `- [MVN Repository](https://mvnrepository.com/artifact/${doc.g}/${doc.a}/${displayVersion})\n`;

		return buildResult(md, {
			url: ctx.url,
			method: "maven",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Maven Central API"],
		});
	},
};

// ============================================================================
// 16. MetaCPAN
// ============================================================================

interface MetaCPANModuleResponse {
	name: string;
	version: string;
	abstract?: string;
	author: string;
	distribution: string;
	release: string;
	path: string;
	pod?: string;
}

interface MetaCPANReleaseResponse {
	name: string;
	version: string;
	abstract?: string;
	author: string;
	distribution: string;
	license?: string[];
	stat?: { mtime: number };
	download_url?: string;
	dependency?: Array<{
		module: string;
		version: string;
		phase: string;
		relationship: string;
	}>;
	metadata?: {
		resources?: {
			repository?: { url?: string; web?: string };
			homepage?: string;
			bugtracker?: { web?: string };
		};
	};
}

function formatMetaCPANResourcesAndDeps(release: MetaCPANReleaseResponse): string {
	let md = "";
	const resources = release.metadata?.resources;
	if (resources?.repository?.web || resources?.repository?.url) {
		const repoUrl = resources.repository.web || resources.repository.url;
		md += `**Repository:** ${repoUrl}\n`;
	}
	if (resources?.homepage) {
		md += `**Homepage:** ${resources.homepage}\n`;
	}
	if (resources?.bugtracker?.web) {
		md += `**Issues:** ${resources.bugtracker.web}\n`;
	}

	const runtimeDeps = release.dependency?.filter(
		d => d.phase === "runtime" && d.relationship === "requires" && d.module !== "perl",
	);
	if (runtimeDeps?.length) {
		md += `\n## Dependencies\n\n`;
		for (const dep of runtimeDeps.slice(0, 20)) {
			md += `- **${dep.module}**`;
			if (dep.version && dep.version !== "0") md += ` >= ${dep.version}`;
			md += "\n";
		}
		if (runtimeDeps.length > 20) {
			md += `\n[…${runtimeDeps.length - 20} dependencies elided…]\n`;
		}
	}
	return md;
}

function formatMetaCPANModuleMarkdown(module: MetaCPANModuleResponse, release: MetaCPANReleaseResponse | null): string {
	let md = `# ${module.name}\n\n`;
	if (module.abstract) md += `${module.abstract}\n\n`;

	md += `**Version:** ${module.version}`;
	md += ` · **Distribution:** ${module.distribution}`;
	md += ` · **Author:** ${markdownLink(module.author, `https://metacpan.org/author/${module.author}`)}\n`;

	if (release) {
		if (release.license?.length) {
			md += `**License:** ${release.license.join(", ")}\n`;
		}
		md += formatMetaCPANResourcesAndDeps(release);
	}

	md += `\n## Installation\n\n\`\`\`bash\ncpanm ${module.name}\n\`\`\`\n`;

	return md;
}

function formatMetaCPANReleaseMarkdown(release: MetaCPANReleaseResponse): string {
	let md = `# ${release.distribution}\n\n`;
	if (release.abstract) md += `${release.abstract}\n\n`;

	md += `**Version:** ${release.version}`;
	md += ` · **Author:** ${markdownLink(release.author, `https://metacpan.org/author/${release.author}`)}\n`;

	if (release.license?.length) {
		md += `**License:** ${release.license.join(", ")}\n`;
	}

	if (release.stat?.mtime) {
		const date = formatIsoDate(release.stat.mtime * 1000);
		md += `**Released:** ${date}\n`;
	}

	md += formatMetaCPANResourcesAndDeps(release);

	md += `\n## Installation\n\n\`\`\`bash\ncpanm ${release.distribution}\n\`\`\`\n`;

	return md;
}

export const metacpanDeclaration: PackageRegistryDeclaration = {
	site: "metacpan",
	hosts: ["metacpan.org", "www.metacpan.org"],
	canonicalUrls: ["https://metacpan.org/pod/Moose", "https://metacpan.org/dist/Moose"],
	match: parsed => {
		const podMatch = parsed.pathname.match(/^\/pod\/(.+?)(?:\/|$)/);
		if (podMatch) return { name: `pod/${decodeURIComponent(podMatch[1])}`, parsedUrl: parsed };
		const releaseMatch = parsed.pathname.match(/^\/release\/([^/]+)\/([^/]+)/);
		if (releaseMatch) return { name: `release/${decodeURIComponent(releaseMatch[2])}`, parsedUrl: parsed };
		const simpleReleaseMatch = parsed.pathname.match(/^\/release\/([^/]+)$/);
		if (simpleReleaseMatch)
			return { name: `release/${decodeURIComponent(simpleReleaseMatch[1])}`, parsedUrl: parsed };
		const distMatch = parsed.pathname.match(/^\/dist\/([^/]+)/);
		if (distMatch) return { name: `release/${decodeURIComponent(distMatch[1])}`, parsedUrl: parsed };
		return null;
	},
	customFetch: async (match, ctx) => {
		const [kind, ...rest] = match.name.split("/");
		const targetName = rest.join("/");

		if (kind === "pod") {
			const apiUrl = `https://fastapi.metacpan.org/v1/module/${targetName}`;
			const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return null;

			const module = ctx.tryParseJson<MetaCPANModuleResponse>(result.content);
			if (!module) return null;

			const releaseUrl = `https://fastapi.metacpan.org/v1/release/${module.distribution}`;
			const releaseResult = await ctx.loadPage(releaseUrl, {
				timeout: Math.min(ctx.timeout, 5),
				signal: ctx.signal,
			});

			let release: MetaCPANReleaseResponse | null = null;
			if (releaseResult.ok) {
				release = ctx.tryParseJson<MetaCPANReleaseResponse>(releaseResult.content);
			}

			const md = formatMetaCPANModuleMarkdown(module, release);
			return buildResult(md, {
				url: ctx.url,
				method: "metacpan",
				fetchedAt: ctx.fetchedAt,
				notes: ["Fetched via MetaCPAN API"],
			});
		}

		const apiUrl = `https://fastapi.metacpan.org/v1/release/${targetName}`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok) return null;

		const release = ctx.tryParseJson<MetaCPANReleaseResponse>(result.content);
		if (!release) return null;

		const md = formatMetaCPANReleaseMarkdown(release);
		return buildResult(md, {
			url: ctx.url,
			method: "metacpan",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via MetaCPAN API"],
		});
	},
};

// ============================================================================
// 17. NPM
// ============================================================================

export const npmDeclaration: PackageRegistryDeclaration = {
	site: "npm",
	hosts: ["npmjs.com", "www.npmjs.com"],
	canonicalUrls: ["https://www.npmjs.com/package/express"],
	pathPattern: /^\/package\/((?:@[^/]+\/)?[^/]+)/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const latestUrl = `https://registry.npmjs.org/${packageName}/latest`;
		const downloadsUrl = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`;

		const [result, downloadsResult] = await Promise.all([
			ctx.loadPage(latestUrl, { timeout: ctx.timeout, signal: ctx.signal }),
			ctx.loadPage(downloadsUrl, { timeout: Math.min(ctx.timeout, 5), signal: ctx.signal }),
		]);

		if (!result.ok) return ctx.scraperDegrade("npm", ctx.loadFailure(result));

		let weeklyDownloads: number | null = null;
		if (downloadsResult.ok) {
			const dlData = ctx.tryParseJson<{ downloads?: number }>(downloadsResult.content);
			if (dlData) weeklyDownloads = dlData.downloads ?? null;
		}

		const pkg = ctx.tryParseJson<{
			name: string;
			version: string;
			description?: string;
			license?: string | { type: string };
			homepage?: string;
			repository?: { url: string } | string;
			keywords?: string[];
			maintainers?: Array<{ name: string }>;
			dependencies?: Record<string, string>;
			readme?: string;
		}>(result.content);
		if (!pkg) return ctx.scraperDegrade("npm", "unexpected response shape");

		let md = `# ${pkg.name}\n\n`;
		if (pkg.description) md += `${pkg.description}\n\n`;

		md += `**Latest:** ${pkg.version || "unknown"}`;
		if (pkg.license) {
			const license = typeof pkg.license === "string" ? pkg.license : (pkg.license.type ?? String(pkg.license));
			md += ` · **License:** ${license}`;
		}
		md += "\n";
		if (weeklyDownloads !== null) {
			md += `**Weekly Downloads:** ${formatNumber(weeklyDownloads)}\n`;
		}
		md += "\n";

		if (pkg.homepage) md += `**Homepage:** ${pkg.homepage}\n`;
		const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
		if (repoUrl) md += `**Repository:** ${repoUrl.replace(/^git\+/, "").replace(/\.git$/, "")}\n`;
		if (pkg.keywords?.length) md += `**Keywords:** ${pkg.keywords.join(", ")}\n`;
		if (pkg.maintainers?.length) md += `**Maintainers:** ${pkg.maintainers.map(m => m.name).join(", ")}\n`;

		md += renderSimpleList(
			"Dependencies",
			pkg.dependencies ? Object.entries(pkg.dependencies) : null,
			([dep, version]) => `${dep}: ${version}`,
		);

		if (pkg.readme) {
			md += `\n---\n\n## README\n\n${pkg.readme}\n`;
		}

		return buildResult(md, {
			url: ctx.url,
			method: "npm",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via npm registry"],
		});
	},
};

// ============================================================================
// 18. NuGet
// ============================================================================

interface NuGetCatalogEntry {
	id: string;
	version: string;
	description?: string;
	authors?: string;
	projectUrl?: string;
	licenseUrl?: string;
	licenseExpression?: string;
	tags?: string[];
	dependencyGroups?: Array<{
		targetFramework?: string;
		dependencies?: Array<{
			id: string;
			range: string;
		}>;
	}>;
	published?: string;
}

interface NuGetRegistrationItem {
	catalogEntry: NuGetCatalogEntry;
	packageContent?: string;
}

interface NuGetRegistrationPage {
	items?: NuGetRegistrationItem[];
	"@id"?: string;
}

interface NuGetRegistrationIndex {
	items: NuGetRegistrationPage[];
}

export const nugetDeclaration: PackageRegistryDeclaration = {
	site: "nuget",
	hosts: ["nuget.org", "www.nuget.org"],
	canonicalUrls: ["https://www.nuget.org/packages/Newtonsoft.Json/"],
	pathPattern: /^\/packages\/([^/]+)(?:\/([^/]+))?/i,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const requestedVersion = match.version || null;

		const apiUrl = `https://api.nuget.org/v3/registration5-gz-semver2/${packageName.toLowerCase()}/index.json`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });

		if (!result.ok) return ctx.scraperDegrade("nuget", ctx.loadFailure(result));

		const index = ctx.tryParseJson<NuGetRegistrationIndex>(result.content);
		if (!index) return ctx.scraperDegrade("nuget", "unexpected response shape");
		if (!index.items?.length) return null;

		let latestPage = index.items[index.items.length - 1];

		if (!latestPage.items && latestPage["@id"]) {
			const pageResult = await ctx.loadPage(latestPage["@id"], { timeout: ctx.timeout, signal: ctx.signal });
			if (!pageResult.ok) return ctx.scraperDegrade("nuget", ctx.loadFailure(pageResult));
			const fetched = ctx.tryParseJson<NuGetRegistrationPage>(pageResult.content);
			if (!fetched) return ctx.scraperDegrade("nuget", "unexpected response shape");
			latestPage = fetched;
		}

		if (!latestPage.items?.length) return null;

		let targetEntry: NuGetCatalogEntry | null = null;

		if (requestedVersion) {
			for (const page of index.items) {
				let pageItems = page.items;

				if (!pageItems && page["@id"]) {
					const pageResult = await ctx.loadPage(page["@id"], {
						timeout: Math.min(ctx.timeout, 5),
						signal: ctx.signal,
					});
					if (pageResult.ok) {
						const fetchedPage = ctx.tryParseJson<NuGetRegistrationPage>(pageResult.content);
						if (fetchedPage) pageItems = fetchedPage.items;
					}
				}

				if (pageItems) {
					const found = pageItems.find(
						item => item.catalogEntry.version.toLowerCase() === requestedVersion.toLowerCase(),
					);
					if (found) {
						targetEntry = found.catalogEntry;
						break;
					}
				}
			}
		}

		if (!targetEntry) {
			const latestItem = latestPage.items[latestPage.items.length - 1];
			targetEntry = latestItem.catalogEntry;
		}

		let totalDownloads: number | null = null;
		const searchUrl = `https://api.nuget.org/v3/query?q=packageid:${encodeURIComponent(packageName)}&prerelease=true&take=1`;
		const searchResult = await ctx.loadPage(searchUrl, { timeout: Math.min(ctx.timeout, 5), signal: ctx.signal });

		if (searchResult.ok) {
			const searchData = ctx.tryParseJson<{ data?: Array<{ totalDownloads?: number }> }>(searchResult.content);
			if (searchData) totalDownloads = searchData.data?.[0]?.totalDownloads ?? null;
		}

		let md = `# ${targetEntry.id}\n\n`;
		if (targetEntry.description) md += `${targetEntry.description}\n\n`;

		md += `**Version:** ${targetEntry.version}`;
		if (targetEntry.licenseExpression) {
			md += ` · **License:** ${targetEntry.licenseExpression}`;
		} else if (targetEntry.licenseUrl) {
			md += ` · **License:** ${markdownLink("View", targetEntry.licenseUrl)}`;
		}
		md += "\n";

		if (totalDownloads !== null) {
			md += `**Total Downloads:** ${formatNumber(totalDownloads)}\n`;
		}

		if (targetEntry.authors) md += `**Authors:** ${targetEntry.authors}\n`;
		if (targetEntry.projectUrl) md += `**Project URL:** ${targetEntry.projectUrl}\n`;
		if (targetEntry.tags?.length) md += `**Tags:** ${targetEntry.tags.join(", ")}\n`;
		if (targetEntry.published) {
			md += `**Published:** ${formatIsoDate(targetEntry.published)}\n`;
		}

		if (targetEntry.dependencyGroups?.length) {
			const hasAnyDeps = targetEntry.dependencyGroups.some(g => g.dependencies?.length);
			if (hasAnyDeps) {
				md += `\n## Dependencies\n\n`;
				for (const group of targetEntry.dependencyGroups) {
					if (!group.dependencies?.length) continue;
					const framework = group.targetFramework || "All Frameworks";
					md += `### ${framework}\n\n`;
					for (const dep of group.dependencies) {
						md += `- ${dep.id} (${dep.range})\n`;
					}
					md += "\n";
				}
			}
		}

		if (latestPage.items && latestPage.items.length > 1) {
			md += `## Recent Versions\n\n`;
			const recentVersions = latestPage.items.slice(-5).reverse();
			for (const item of recentVersions) {
				const entry = item.catalogEntry;
				const pubDate = formatIsoDate(entry.published) || "unknown";
				md += `- **${entry.version}** (${pubDate})\n`;
			}
		}

		return buildResult(md, {
			url: ctx.url,
			method: "nuget",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via NuGet API"],
		});
	},
};

// ============================================================================
// 19. Open VSX
// ============================================================================

interface OpenVsxFileLinks {
	readme?: string;
}

interface OpenVsxExtension {
	name: string;
	namespace: string;
	version: string;
	displayName?: string;
	description?: string;
	downloadCount?: number;
	averageRating?: number;
	reviewCount?: number;
	repository?: string | { url?: string };
	license?: string;
	categories?: string[];
	homepage?: string;
	files?: OpenVsxFileLinks;
}

export const openVsxDeclaration: PackageRegistryDeclaration = {
	site: "open-vsx",
	hosts: ["open-vsx.org", "www.open-vsx.org"],
	canonicalUrls: ["https://open-vsx.org/extension/rust-lang/rust-analyzer"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/extension\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/);
		if (!match) return null;
		const namespace = decodeURIComponent(match[1]);
		const extension = decodeURIComponent(match[2]);
		const version = match[3] ? decodeURIComponent(match[3]) : undefined;
		return { name: `${namespace}/${extension}`, version, parsedUrl: parsed };
	},
	customFetch: async (match, ctx) => {
		const [namespace, extension] = match.name.split("/");
		const version = match.version;

		const baseUrl = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(extension)}`;
		const apiUrl = version ? `${baseUrl}/${encodeURIComponent(version)}` : baseUrl;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok) return ctx.scraperDegrade("open-vsx", ctx.loadFailure(result));

		const data = ctx.tryParseJson<OpenVsxExtension>(result.content);
		if (!data) return ctx.scraperDegrade("open-vsx", "unexpected response shape");

		let readme: string | null = null;
		const readmeUrl = data.files?.readme;
		if (readmeUrl) {
			try {
				const readmeResult = await ctx.loadPage(readmeUrl, {
					timeout: Math.min(ctx.timeout, 10),
					signal: ctx.signal,
				});
				if (readmeResult.ok) readme = readmeResult.content;
				else
					logger.warn("Open VSX readme could not be fetched; the extension renders without it", {
						url: readmeUrl,
						reason: ctx.loadFailure(readmeResult),
					});
			} catch (error) {
				if (isCancellation(error)) throw error;
				logger.warn("Open VSX readme could not be fetched; the extension renders without it", {
					url: readmeUrl,
					error: errorMessage(error),
				});
			}
		}

		const displayName = data.displayName || data.name || `${namespace}/${extension}`;
		const displayNamespace = data.namespace || namespace;
		const displayVersion = data.version || version || "unknown";
		const downloads = typeof data.downloadCount === "number" ? data.downloadCount : null;
		const rating = typeof data.averageRating === "number" ? data.averageRating : null;
		const reviews = typeof data.reviewCount === "number" ? data.reviewCount : null;
		const repository = typeof data.repository === "string" ? data.repository : data.repository?.url || null;

		let md = renderHeader(displayName, data.description);
		md += `**Namespace:** ${displayNamespace}\n`;
		md += `**Extension:** ${data.name || extension}\n`;
		md += `**Version:** ${displayVersion}${data.license ? ` | **License:** ${data.license}` : ""}\n`;

		if (downloads !== null) {
			md += `**Downloads:** ${formatNumber(downloads)}\n`;
		}

		if (rating !== null) {
			const reviewSuffix = reviews !== null ? ` (${reviews} reviews)` : "";
			md += `**Rating:** ${rating}${reviewSuffix}\n`;
		}

		if (repository) md += `**Repository:** ${repository.replace(/^git\+/, "").replace(/\.git$/, "")}\n`;
		if (data.homepage) md += `**Homepage:** ${data.homepage}\n`;
		if (data.categories?.length) md += `**Categories:** ${data.categories.join(", ")}\n`;
		md += renderReadme(readme);

		return buildResult(md, {
			url: ctx.url,
			method: "open-vsx",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Open VSX API"],
		});
	},
};

// ============================================================================
// 20. Packagist (PHP)
// ============================================================================

export const packagistDeclaration: PackageRegistryDeclaration = {
	site: "packagist",
	hosts: ["packagist.org", "www.packagist.org"],
	canonicalUrls: ["https://packagist.org/packages/laravel/framework"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/packages\/([^/]+)\/([^/]+)/);
		if (!match) return null;
		return { name: `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`, parsedUrl: parsed };
	},
	customFetch: async (match, ctx) => {
		const [vendor, packageName] = match.name.split("/");
		const apiUrl = `https://packagist.org/packages/${vendor}/${packageName}.json`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });

		if (!result.ok) return ctx.scraperDegrade("packagist", ctx.loadFailure(result));

		const data = ctx.tryParseJson<{
			package: {
				name: string;
				description?: string;
				time?: string;
				maintainers?: Array<{ name: string; avatar_url?: string }>;
				versions?: Record<
					string,
					{
						name: string;
						version: string;
						version_normalized?: string;
						description?: string;
						license?: string[];
						homepage?: string;
						source?: { url: string; type: string };
						require?: Record<string, string>;
						"require-dev"?: Record<string, string>;
						authors?: Array<{ name: string; email?: string }>;
						time?: string;
					}
				>;
				type?: string;
				repository?: string;
				github_stars?: number;
				github_watchers?: number;
				github_forks?: number;
				github_open_issues?: number;
				language?: string;
				dependents?: number;
				suggesters?: number;
				downloads?: {
					total: number;
					monthly: number;
					daily: number;
				};
				favers?: number;
			};
		}>(result.content);
		if (!data) return ctx.scraperDegrade("packagist", "unexpected response shape");

		const pkg = data.package;
		if (!pkg) return null;

		type VersionInfo = NonNullable<typeof pkg.versions>[string];
		let latestVersion: VersionInfo | null = null;
		let latestVersionKey = "";

		if (pkg.versions) {
			for (const [key, ver] of Object.entries(pkg.versions)) {
				if (key === "dev-master" || key === "dev-main" || key.includes("-dev")) continue;
				if (!latestVersion || (ver.time && latestVersion.time && ver.time > latestVersion.time)) {
					latestVersion = ver;
					latestVersionKey = key;
				}
			}
			if (!latestVersion) {
				latestVersion = pkg.versions["dev-master"] || pkg.versions["dev-main"] || Object.values(pkg.versions)[0];
				latestVersionKey = latestVersion?.version || "";
			}
		}

		let md = `# ${pkg.name}\n\n`;
		if (pkg.description) md += `${pkg.description}\n\n`;

		md += `**Latest:** ${latestVersionKey || "unknown"}`;
		if (latestVersion?.license?.length) md += ` · **License:** ${latestVersion.license.join(", ")}`;
		if (pkg.type) md += ` · **Type:** ${pkg.type}`;
		md += "\n";

		if (pkg.downloads) {
			md += `**Downloads:** ${formatNumber(pkg.downloads.total)} total · ${formatNumber(pkg.downloads.monthly)}/month\n`;
		}
		if (pkg.favers) md += `**Stars:** ${formatNumber(pkg.favers)}\n`;
		md += "\n";

		if (latestVersion?.authors?.length) {
			const authorList = latestVersion.authors
				.map((a: { name: string; email?: string }) => (a.email ? `${a.name} <${a.email}>` : a.name))
				.join(", ");
			md += `**Authors:** ${authorList}\n`;
		}

		if (pkg.maintainers?.length) {
			md += `**Maintainers:** ${pkg.maintainers.map(m => m.name).join(", ")}\n`;
		}

		if (latestVersion?.homepage) md += `**Homepage:** ${latestVersion.homepage}\n`;
		if (pkg.repository) md += `**Repository:** ${pkg.repository}\n`;
		else if (latestVersion?.source?.url) {
			const repoUrl = latestVersion.source.url.replace(/\.git$/, "");
			md += `**Repository:** ${repoUrl}\n`;
		}

		if (pkg.github_stars || pkg.github_forks) {
			const stats: string[] = [];
			if (pkg.github_stars) stats.push(`${formatNumber(pkg.github_stars)} stars`);
			if (pkg.github_forks) stats.push(`${formatNumber(pkg.github_forks)} forks`);
			if (pkg.github_open_issues) stats.push(`${pkg.github_open_issues} open issues`);
			md += `**GitHub:** ${stats.join(" · ")}\n`;
		}

		md += renderSimpleList(
			"Requirements",
			latestVersion?.require ? Object.entries(latestVersion.require) : null,
			([dep, version]) => `${dep}: ${version}`,
		);
		md += renderSimpleList(
			"Dev Requirements",
			latestVersion?.["require-dev"] ? Object.entries(latestVersion["require-dev"]) : null,
			([dep, version]) => `${dep}: ${version}`,
		);

		return buildResult(md, {
			url: ctx.url,
			method: "packagist",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Packagist API"],
		});
	},
};

// ============================================================================
// 21. Pub.dev (Dart/Flutter)
// ============================================================================

export const pubDevDeclaration: PackageRegistryDeclaration = {
	site: "pub-dev",
	hosts: ["pub.dev", "www.pub.dev"],
	canonicalUrls: ["https://pub.dev/packages/flutter_bloc"],
	pathPattern: /^\/packages\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const apiUrl = `https://pub.dev/api/packages/${encodeURIComponent(packageName)}`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });

		if (!result.ok) return ctx.scraperDegrade("pub-dev", ctx.loadFailure(result));

		const data = ctx.tryParseJson<{
			name: string;
			latest: {
				version: string;
				pubspec: {
					description?: string;
					homepage?: string;
					repository?: string;
					documentation?: string;
					environment?: Record<string, string>;
					dependencies?: Record<string, unknown>;
					dev_dependencies?: Record<string, unknown>;
				};
			};
			publisherId?: string;
			metrics?: {
				score?: {
					likeCount?: number;
					grantedPoints?: number;
					maxPoints?: number;
					popularityScore?: number;
				};
			};
		}>(result.content);
		if (!data) return ctx.scraperDegrade("pub-dev", "unexpected response shape");

		const { name, latest, publisherId, metrics } = data;
		const pubspec = latest.pubspec;

		let md = `# ${name}\n\n`;
		if (pubspec.description) md += `${pubspec.description}\n\n`;

		md += `**Latest:** ${latest.version}`;
		if (publisherId) md += ` · **Publisher:** ${publisherId}`;
		md += "\n";

		const score = metrics?.score;
		if (score) {
			const likes = score.likeCount;
			const points = score.grantedPoints;
			const maxPoints = score.maxPoints;
			const popularity = score.popularityScore;

			if (likes !== undefined) md += `**Likes:** ${formatNumber(likes)}`;
			if (points !== undefined && maxPoints !== undefined) {
				md += ` · **Pub Points:** ${points}/${maxPoints}`;
			}
			if (popularity !== undefined) {
				md += ` · **Popularity:** ${Math.round(popularity * 100)}%`;
			}
			md += "\n";
		}

		md += "\n";

		if (pubspec.homepage) md += `**Homepage:** ${pubspec.homepage}\n`;
		if (pubspec.repository) md += `**Repository:** ${pubspec.repository}\n`;
		if (pubspec.documentation) md += `**Documentation:** ${pubspec.documentation}\n`;

		if (pubspec.environment) {
			const constraints: string[] = [];
			for (const [key, value] of Object.entries(pubspec.environment)) {
				constraints.push(`${key}: ${value}`);
			}
			if (constraints.length > 0) {
				md += `**SDK:** ${constraints.join(", ")}\n`;
			}
		}

		md += "\n";

		if (pubspec.dependencies) {
			const deps = Object.keys(pubspec.dependencies);
			if (deps.length > 0) {
				md += `## Dependencies (${deps.length})\n\n`;
				for (const dep of deps.slice(0, 20)) {
					const constraint = pubspec.dependencies[dep];
					const constraintStr =
						typeof constraint === "string" ? constraint : typeof constraint === "object" ? "complex" : "";
					md += `- ${dep}`;
					if (constraintStr) md += `: ${constraintStr}`;
					md += "\n";
				}
				if (deps.length > 20) {
					md += `\n[…${deps.length - 20} dependencies elided…]\n`;
				}
				md += "\n";
			}
		}

		const readmeUrl = `https://pub.dev/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(latest.version)}/readme`;
		try {
			const readmeResult = await ctx.loadPage(readmeUrl, { timeout: Math.min(ctx.timeout, 10), signal: ctx.signal });
			if (readmeResult.ok) {
				const readmeMatch = readmeResult.content.match(
					/<div[^>]*class="[^"]*markdown-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
				);
				if (readmeMatch) {
					const readme = await htmlToBasicMarkdown(readmeMatch[1]);
					if (readme.length > 100) {
						md += `## README\n\n${readme}\n`;
					}
				}
			}
		} catch {
			// Continue without README
		}

		return buildResult(md, {
			url: ctx.url,
			method: "pub.dev",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via pub.dev API"],
		});
	},
};

// ============================================================================
// 22. PyPI (Python)
// ============================================================================

export const pypiDeclaration: PackageRegistryDeclaration = {
	site: "pypi",
	hosts: ["pypi.org", "www.pypi.org"],
	canonicalUrls: ["https://pypi.org/project/requests/"],
	pathPattern: /^\/project\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const apiUrl = `https://pypi.org/pypi/${packageName}/json`;
		const downloadsUrl = `https://pypistats.org/api/packages/${packageName}/recent`;

		const [result, downloadsResult] = await Promise.all([
			ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal }),
			ctx.loadPage(downloadsUrl, { timeout: Math.min(ctx.timeout, 5), signal: ctx.signal }),
		]);

		if (!result.ok) return ctx.scraperDegrade("pypi", ctx.loadFailure(result));

		let weeklyDownloads: number | null = null;
		if (downloadsResult.ok) {
			const dlData = ctx.tryParseJson<{ data?: { last_week?: number } }>(downloadsResult.content);
			if (dlData) weeklyDownloads = dlData.data?.last_week ?? null;
		}

		const pkg = ctx.tryParseJson<{
			info: {
				name: string;
				version: string;
				summary?: string;
				description?: string;
				author?: string;
				author_email?: string;
				license?: string;
				home_page?: string;
				project_urls?: Record<string, string>;
				requires_python?: string;
				keywords?: string;
				classifiers?: string[];
			};
			urls?: Array<{ filename: string; size: number; upload_time: string }>;
			releases?: Record<string, unknown>;
			requires_dist?: string[];
		}>(result.content);
		if (!pkg) return ctx.scraperDegrade("pypi", "unexpected response shape");
		const info = pkg.info;
		let md = renderHeader(info.name, info.summary);
		md += `**Latest:** ${info.version}`;
		if (info.license) md += ` · **License:** ${info.license}`;
		md += "\n";

		if (weeklyDownloads !== null) {
			md += `**Weekly Downloads:** ${formatNumber(weeklyDownloads)}\n`;
		}
		md += "\n";

		if (info.author) {
			md += `**Author:** ${info.author}${info.author_email ? ` <${info.author_email}>` : ""}\n`;
		}

		if (info.requires_python) md += `**Python:** ${info.requires_python}\n`;
		if (info.home_page) md += `**Homepage:** ${info.home_page}\n`;

		if (info.project_urls && Object.keys(info.project_urls).length > 0) {
			md += "\n**Project URLs:**\n";
			for (const [label, url] of Object.entries(info.project_urls)) {
				md += `- ${label}: ${url}\n`;
			}
		}

		if (info.keywords) md += `\n**Keywords:** ${info.keywords}\n`;

		md += renderStringList("Dependencies", pkg.requires_dist);
		md += renderReadme(info.description, "Description");

		return buildResult(md, {
			url: ctx.url,
			method: "pypi",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via PyPI JSON API"],
		});
	},
};

// ============================================================================
// 23. Repology
// ============================================================================

interface RepologyPackage {
	repo: string;
	subrepo?: string;
	srcname?: string;
	binname?: string;
	visiblename?: string;
	version: string;
	origversion?: string;
	status:
		| "newest"
		| "devel"
		| "unique"
		| "outdated"
		| "legacy"
		| "rolling"
		| "noscheme"
		| "incorrect"
		| "untrusted"
		| "ignored";
	summary?: string;
	categories?: string[];
	licenses?: string[];
	maintainers?: string[];
}

function repologyStatusIndicator(status: string): string {
	switch (status) {
		case "newest":
			return "✅";
		case "devel":
			return "🚧";
		case "unique":
			return "🔵";
		case "outdated":
			return "🔴";
		case "legacy":
			return "⚠\uFE0F";
		case "rolling":
			return "🔄";
		default:
			return "➖";
	}
}

function prettifyRepologyRepo(repo: string): string {
	const mapping: Record<string, string> = {
		arch: "Arch Linux",
		aur: "AUR",
		debian_unstable: "Debian Unstable",
		debian_stable: "Debian Stable",
		ubuntu_24_04: "Ubuntu 24.04",
		ubuntu_22_04: "Ubuntu 22.04",
		fedora_rawhide: "Fedora Rawhide",
		fedora_40: "Fedora 40",
		gentoo: "Gentoo",
		nix_unstable: "Nixpkgs Unstable",
		nix_stable: "Nixpkgs Stable",
		homebrew: "Homebrew",
		macports: "MacPorts",
		alpine_edge: "Alpine Edge",
		freebsd: "FreeBSD",
		openbsd: "OpenBSD",
		void_x86_64: "Void Linux",
		opensuse_tumbleweed: "openSUSE Tumbleweed",
		msys2_mingw: "MSYS2",
		chocolatey: "Chocolatey",
		winget: "Winget",
		scoop: "Scoop",
		conda_main: "Conda",
		pypi: "PyPI",
		crates_io: "Crates.io",
		npm: "npm",
		rubygems: "RubyGems",
		cpan: "CPAN",
		hackage: "Hackage",
	};

	if (mapping[repo]) return mapping[repo];

	for (const [key, value] of Object.entries(mapping)) {
		if (repo.startsWith(key)) return value;
	}

	return repo
		.split("_")
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

export const repologyDeclaration: PackageRegistryDeclaration = {
	site: "repology",
	hosts: ["repology.org", "www.repology.org"],
	canonicalUrls: ["https://repology.org/project/ripgrep"],
	pathPattern: /^\/project\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const packageName = match.name;
		const apiUrl = `https://repology.org/api/v1/project/${encodeURIComponent(packageName)}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			headers: {
				Accept: "application/json",
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("repology", ctx.loadFailure(result));

		const packages = ctx.tryParseJson<RepologyPackage[]>(result.content);
		if (!packages) return ctx.scraperDegrade("repology", "unexpected response shape");
		if (!Array.isArray(packages) || packages.length === 0) return null;

		const newestVersions = new Set<string>();
		let summary: string | undefined;
		let licenses: string[] = [];
		const categories = new Set<string>();

		for (const pkg of packages) {
			if (pkg.status === "newest" || pkg.status === "unique") {
				newestVersions.add(pkg.version);
			}
			if (!summary && pkg.summary) summary = pkg.summary;
			if (pkg.licenses?.length && !licenses.length) licenses = pkg.licenses;
			if (pkg.categories) {
				for (const cat of pkg.categories) categories.add(cat);
			}
		}

		if (newestVersions.size === 0) {
			const versions = packages.map(p => p.version);
			if (versions.length > 0) newestVersions.add(versions[0]);
		}

		const statusCounts: Record<string, number> = {};
		for (const pkg of packages) {
			statusCounts[pkg.status] = (statusCounts[pkg.status] || 0) + 1;
		}

		let md = renderHeader(packageName, summary);
		md += `**Newest Version:** ${Array.from(newestVersions).join(", ") || "unknown"}\n`;
		md += `**Repositories:** ${packages.length}\n`;
		if (licenses.length > 0) md += `**License:** ${licenses.join(", ")}\n`;
		if (categories.size > 0) md += `**Categories:** ${Array.from(categories).join(", ")}\n`;
		md += "\n";

		md += "## Version Status Summary\n\n";
		const statusOrder = [
			"newest",
			"unique",
			"devel",
			"rolling",
			"outdated",
			"legacy",
			"noscheme",
			"incorrect",
			"untrusted",
			"ignored",
		];
		for (const status of statusOrder) {
			if (statusCounts[status]) {
				md += `- ${repologyStatusIndicator(status)} **${status}**: ${statusCounts[status]} repos\n`;
			}
		}
		md += "\n";

		const sortedPackages = [...packages].sort((a, b) => {
			const statusPriority: Record<string, number> = {
				newest: 0,
				unique: 1,
				devel: 2,
				rolling: 3,
				outdated: 4,
				legacy: 5,
				noscheme: 6,
				incorrect: 7,
				untrusted: 8,
				ignored: 9,
			};
			const aPriority = statusPriority[a.status] ?? 10;
			const bPriority = statusPriority[b.status] ?? 10;
			if (aPriority !== bPriority) return aPriority - bPriority;
			return a.repo.localeCompare(b.repo);
		});

		md += "## Package Versions by Repository\n\n";
		md += "| Repository | Version | Status |\n";
		md += "|------------|---------|--------|\n";

		const shownRepos = new Set<string>();
		let count = 0;
		for (const pkg of sortedPackages) {
			const repoKey = pkg.subrepo ? `${pkg.repo}/${pkg.subrepo}` : pkg.repo;
			if (shownRepos.has(repoKey)) continue;
			shownRepos.add(repoKey);

			const repoName = escapeMarkdownTableCell(prettifyRepologyRepo(pkg.repo));
			const version = escapeMarkdownTableCell(pkg.origversion || pkg.version);
			md += `| ${repoName} | \`${version}\` | ${repologyStatusIndicator(pkg.status)} ${pkg.status} |\n`;

			count++;
			if (count >= 15) break;
		}

		if (packages.length > 15) {
			md += `\n[…${packages.length - 15} repositories elided…]\n`;
		}

		md += `\n---\n\n${markdownLink("View on Repology", ctx.url)}\n`;

		return buildResult(md, {
			url: ctx.url,
			method: "repology",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Repology API"],
		});
	},
};

// ============================================================================
// 24. RubyGems
// ============================================================================

interface RubyGemsDependency {
	name: string;
	requirements: string;
}

interface RubyGemsResponse {
	name: string;
	version: string;
	version_created_at?: string;
	authors?: string;
	info?: string;
	licenses?: string[];
	homepage_uri?: string;
	source_code_uri?: string;
	documentation_uri?: string;
	project_uri?: string;
	downloads: number;
	version_downloads?: number;
	gem_uri?: string;
	dependencies?: {
		development?: RubyGemsDependency[];
		runtime?: RubyGemsDependency[];
	};
	metadata?: Record<string, string>;
}

export const rubygemsDeclaration: PackageRegistryDeclaration = {
	site: "rubygems",
	hosts: ["rubygems.org", "www.rubygems.org"],
	canonicalUrls: ["https://rubygems.org/gems/rails"],
	pathPattern: /^\/gems\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const gemName = match.name;
		const apiUrl = `https://rubygems.org/api/v1/gems/${encodeURIComponent(gemName)}.json`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: { Accept: "application/json" },
		});

		if (!result.ok) return ctx.scraperDegrade("rubygems", ctx.loadFailure(result));

		const gem = ctx.tryParseJson<RubyGemsResponse>(result.content);
		if (!gem) return ctx.scraperDegrade("rubygems", "unexpected response shape");

		let md = renderHeader(gem.name, gem.info);
		md += `**Version:** ${gem.version}`;
		if (gem.licenses?.length) md += ` · **License:** ${gem.licenses.join(", ")}`;
		md += "\n";

		md += `**Total Downloads:** ${formatNumber(gem.downloads)}`;
		if (gem.version_downloads) {
			md += ` · **Version Downloads:** ${formatNumber(gem.version_downloads)}`;
		}
		md += "\n\n";

		if (gem.homepage_uri) md += `**Homepage:** ${gem.homepage_uri}\n`;
		if (gem.source_code_uri) md += `**Source Code:** ${gem.source_code_uri}\n`;
		if (gem.documentation_uri) md += `**Documentation:** ${gem.documentation_uri}\n`;
		if (gem.authors) md += `**Authors:** ${gem.authors}\n`;

		md += renderSimpleList(
			"Runtime Dependencies",
			gem.dependencies?.runtime,
			dep => `${dep.name} ${dep.requirements}`,
		);
		md += renderSimpleList(
			"Development Dependencies",
			gem.dependencies?.development,
			dep => `${dep.name} ${dep.requirements}`,
		);

		return buildResult(md, {
			url: ctx.url,
			method: "rubygems",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via RubyGems API"],
		});
	},
};

// ============================================================================
// 25. Snapcraft
// ============================================================================

interface SnapcraftPublisher {
	"display-name"?: string;
	username?: string;
	id?: string;
	validation?: string;
}

interface SnapcraftChannel {
	name?: string;
	track?: string;
	risk?: string;
	branch?: string | null;
	architecture?: string;
	"released-at"?: string;
}

interface SnapcraftDownload {
	size?: number;
	url?: string;
	"sha3-384"?: string;
}

interface SnapcraftChannelMapEntry {
	channel?: SnapcraftChannel;
	version?: string;
	revision?: number | string;
	download?: SnapcraftDownload;
	type?: string;
	"created-at"?: string;
}

interface SnapcraftSnap {
	name?: string;
	title?: string;
	summary?: string;
	description?: string;
	publisher?: SnapcraftPublisher;
	version?: string;
	confinement?: string;
	base?: string;
	downloads?: number;
	download?: number;
}

interface SnapcraftResponse {
	name?: string;
	title?: string;
	summary?: string;
	description?: string;
	publisher?: SnapcraftPublisher;
	version?: string;
	confinement?: string;
	base?: string;
	downloads?: number;
	download?: number;
	snap?: SnapcraftSnap;
	"channel-map"?: SnapcraftChannelMapEntry[];
}

function formatSnapcraftPublisher(publisher?: SnapcraftPublisher): string | null {
	if (!publisher) return null;
	const displayName = publisher["display-name"] ?? publisher.username ?? publisher.id;
	if (!displayName) return null;
	if (publisher.username && displayName !== publisher.username) {
		return `${displayName} (@${publisher.username})`;
	}
	return displayName;
}

function formatSnapcraftChannelName(channel?: SnapcraftChannel): string | null {
	if (!channel) return null;
	if (channel.name?.includes("/")) return channel.name;
	if (channel.track && channel.risk) {
		const branch = channel.branch ? `/${channel.branch}` : "";
		return `${channel.track}/${channel.risk}${branch}`;
	}
	return channel.name ?? null;
}

function pickSnapcraftVersionFromChannels(entries: SnapcraftChannelMapEntry[]): string | undefined {
	const stable = entries.find(entry => entry.channel?.risk === "stable" && entry.version);
	if (stable?.version) return stable.version;
	const first = entries.find(entry => entry.version);
	return first?.version;
}

function extractSnapcraftDownloads(
	snapInfo: SnapcraftSnap | SnapcraftResponse,
	data: SnapcraftResponse,
): number | null {
	const candidates = [snapInfo.downloads, snapInfo.download, data.downloads, data.download];
	for (const value of candidates) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

export const snapcraftDeclaration: PackageRegistryDeclaration = {
	site: "snapcraft",
	hosts: ["snapcraft.io", "www.snapcraft.io"],
	canonicalUrls: ["https://snapcraft.io/vlc"],
	pathPattern: /^\/([^/]+)/,
	customFetch: async (match, ctx) => {
		const snapName = match.name;
		const apiUrl = `https://api.snapcraft.io/v2/snaps/info/${encodeURIComponent(snapName)}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: {
				Accept: "application/json",
				"Snap-Device-Series": "16",
			},
		});
		if (!result.ok) return ctx.scraperDegrade("snapcraft", ctx.loadFailure(result));

		const data = ctx.tryParseJson<SnapcraftResponse>(result.content);
		if (!data) return ctx.scraperDegrade("snapcraft", "unexpected response shape");

		const snapInfo = data.snap ?? data;
		const name = snapInfo.title ?? snapInfo.name ?? data.name ?? snapName;
		const summary = snapInfo.summary ?? data.summary;
		const description = snapInfo.description ?? data.description;
		const publisher = formatSnapcraftPublisher(snapInfo.publisher ?? data.publisher);
		const confinement = snapInfo.confinement ?? data.confinement;
		const base = snapInfo.base ?? data.base;

		const channelMap = data["channel-map"] ?? [];
		let version = snapInfo.version ?? data.version;
		if (!version && channelMap.length > 0) {
			version = pickSnapcraftVersionFromChannels(channelMap);
		}

		const downloads = extractSnapcraftDownloads(snapInfo, data);

		const channels = new Map<string, { version?: string; architectures: Set<string> }>();
		for (const entry of channelMap) {
			const channelName = formatSnapcraftChannelName(entry.channel);
			if (!channelName) continue;
			const existing = channels.get(channelName) ?? { architectures: new Set<string>() };
			if (!existing.version && entry.version) existing.version = entry.version;
			if (entry.channel?.architecture) existing.architectures.add(entry.channel.architecture);
			channels.set(channelName, existing);
		}

		let md = renderHeader(name, summary);
		md += `**Version:** ${version ?? "unknown"}`;
		if (confinement) md += ` · **Confinement:** ${confinement}`;
		if (base) md += ` · **Base:** ${base}`;
		md += "\n";

		if (publisher) md += `**Publisher:** ${publisher}\n`;
		if (downloads !== null) md += `**Downloads:** ${formatNumber(downloads)}\n`;
		md += "\n";

		if (channels.size > 0) {
			md += "## Channels\n\n";
			const sortedChannels = Array.from(channels.entries()).sort((a, b) => a[0].localeCompare(b[0]));
			for (const [channelName, info] of sortedChannels) {
				const arches = Array.from(info.architectures).sort();
				const versionSuffix = info.version ? `: ${info.version}` : "";
				const archSuffix = arches.length > 0 ? ` (${arches.join(", ")})` : "";
				md += `- ${channelName}${versionSuffix}${archSuffix}\n`;
			}
			md += "\n";
		}

		const descriptionText = description ?? summary;
		if (descriptionText) {
			md += `## Description\n\n${descriptionText}\n`;
		}

		return buildResult(md, {
			url: ctx.url,
			method: "snapcraft",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Snapcraft API"],
		});
	},
};

// ============================================================================
// 26. Terraform Registry
// ============================================================================

interface TerraformModule {
	id: string;
	namespace: string;
	name: string;
	provider: string;
	version: string;
	description?: string;
	source?: string;
	published_at?: string;
	downloads: number;
	verified?: boolean;
	root?: {
		inputs?: Array<{
			name: string;
			type?: string;
			description?: string;
			default?: unknown;
			required?: boolean;
		}>;
		outputs?: Array<{
			name: string;
			description?: string;
		}>;
		dependencies?: Array<{
			name: string;
			source: string;
			version?: string;
		}>;
		resources?: Array<{
			name: string;
			type: string;
		}>;
	};
	submodules?: Array<{
		path: string;
		name: string;
	}>;
}

interface TerraformProvider {
	id: string;
	namespace: string;
	name: string;
	alias?: string;
	version: string;
	description?: string;
	source?: string;
	published_at?: string;
	downloads: number;
	tier?: string;
	logo_url?: string;
	docs?: Array<{
		id: string;
		title: string;
		path: string;
		slug: string;
		category: string;
	}>;
}

export const terraformDeclaration: PackageRegistryDeclaration = {
	site: "terraform",
	hosts: ["registry.terraform.io"],
	canonicalUrls: [
		"https://registry.terraform.io/providers/hashicorp/aws/latest",
		"https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest",
	],
	match: parsed => {
		const moduleMatch = parsed.pathname.match(/^\/modules\/([^/]+)\/([^/]+)\/([^/]+)/);
		if (moduleMatch) {
			return { name: `modules/${moduleMatch[1]}/${moduleMatch[2]}/${moduleMatch[3]}`, parsedUrl: parsed };
		}
		const providerMatch = parsed.pathname.match(/^\/providers\/([^/]+)\/([^/]+)/);
		if (providerMatch) {
			return { name: `providers/${providerMatch[1]}/${providerMatch[2]}`, parsedUrl: parsed };
		}
		return null;
	},
	customFetch: async (match, ctx) => {
		const parts = match.name.split("/");
		const kind = parts[0];

		if (kind === "modules") {
			const [, namespace, name, provider] = parts;
			const apiUrl = `https://registry.terraform.io/v1/modules/${namespace}/${name}/${provider}`;
			const result = await ctx.loadPage(apiUrl, {
				timeout: ctx.timeout,
				signal: ctx.signal,
				headers: { Accept: "application/json" },
			});

			if (!result.ok) return null;

			const mod = ctx.tryParseJson<TerraformModule>(result.content);
			if (!mod) return null;

			let md = `# ${mod.namespace}/${mod.name}/${mod.provider}\n\n`;

			if (mod.description) md += `${mod.description}\n\n`;

			md += `**Version:** ${mod.version}`;
			if (mod.verified) md += " ✓ Verified";
			md += `\n`;
			md += `**Downloads:** ${formatNumber(mod.downloads)}\n`;
			if (mod.published_at) {
				md += `**Published:** ${new Date(mod.published_at).toLocaleDateString()}\n`;
			}
			if (mod.source) {
				md += `**Source:** ${mod.source}\n`;
			}
			md += "\n";

			md += `## Usage\n\n\`\`\`hcl\nmodule "${mod.name}" {\n  source  = "${mod.namespace}/${mod.name}/${mod.provider}"\n  version = "${mod.version}"\n}\n\`\`\`\n\n`;

			const inputs = mod.root?.inputs;
			if (inputs && inputs.length > 0) {
				md += `## Inputs (${inputs.length})\n\n`;
				md += "| Name | Type | Required | Description |\n";
				md += "|------|------|----------|-------------|\n";
				for (const input of inputs.slice(0, 30)) {
					const required = (input.required ?? input.default === undefined) ? "Yes" : "No";
					const inputName = escapeMarkdownTableCell(input.name);
					const type = escapeMarkdownTableCell(input.type ?? "any");
					const desc = escapeMarkdownTableCell((input.description ?? "").slice(0, 80));
					md += `| ${inputName} | \`${type}\` | ${required} | ${desc} |\n`;
				}
				if (inputs.length > 30) {
					md += `\n[…${inputs.length - 30} inputs elided…]\n`;
				}
				md += "\n";
			}

			const outputs = mod.root?.outputs;
			if (outputs && outputs.length > 0) {
				md += `## Outputs (${outputs.length})\n\n`;
				for (const output of outputs.slice(0, 20)) {
					md += `- **${output.name}**`;
					if (output.description) md += `: ${output.description.replace(/\n/g, " ").slice(0, 100)}`;
					md += "\n";
				}
				if (outputs.length > 20) {
					md += `\n[…${outputs.length - 20} outputs elided…]\n`;
				}
				md += "\n";
			}

			const deps = mod.root?.dependencies;
			if (deps && deps.length > 0) {
				md += `## Dependencies (${deps.length})\n\n`;
				for (const dep of deps.slice(0, 15)) {
					md += `- **${dep.name}**: ${dep.source}`;
					if (dep.version) md += ` (${dep.version})`;
					md += "\n";
				}
				if (deps.length > 15) {
					md += `\n[…${deps.length - 15} dependencies elided…]\n`;
				}
				md += "\n";
			}

			const resources = mod.root?.resources;
			if (resources && resources.length > 0) {
				md += `## Resources (${resources.length})\n\n`;
				for (const res of resources.slice(0, 20)) {
					md += `- \`${res.type}\` (${res.name})\n`;
				}
				if (resources.length > 20) {
					md += `\n[…${resources.length - 20} resources elided…]\n`;
				}
				md += "\n";
			}

			if (mod.submodules && mod.submodules.length > 0) {
				md += `## Submodules (${mod.submodules.length})\n\n`;
				for (const sub of mod.submodules.slice(0, 10)) {
					md += `- **${sub.name}**: \`${sub.path}\`\n`;
				}
				if (mod.submodules.length > 10) {
					md += `\n[…${mod.submodules.length - 10} submodules elided…]\n`;
				}
			}

			return buildResult(md, {
				url: ctx.url,
				method: "terraform",
				fetchedAt: ctx.fetchedAt,
				notes: ["Fetched via Terraform Registry API"],
			});
		}

		const [, namespace, type] = parts;
		const apiUrl = `https://registry.terraform.io/v1/providers/${namespace}/${type}`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: { Accept: "application/json" },
		});

		if (!result.ok) return null;

		const provider = ctx.tryParseJson<TerraformProvider>(result.content);
		if (!provider) return null;

		let md = `# ${provider.namespace}/${provider.name}\n\n`;

		if (provider.description) md += `${provider.description}\n\n`;

		md += `**Version:** ${provider.version}\n`;
		if (provider.tier) md += `**Tier:** ${provider.tier}\n`;
		md += `**Downloads:** ${formatNumber(provider.downloads)}\n`;
		if (provider.published_at) {
			md += `**Published:** ${new Date(provider.published_at).toLocaleDateString()}\n`;
		}
		if (provider.source) {
			md += `**Source:** ${provider.source}\n`;
		}
		md += "\n";

		md += `## Usage\n\n\`\`\`hcl\nterraform {\n  required_providers {\n    ${provider.name} = {\n      source  = "${provider.namespace}/${provider.name}"\n      version = "~> ${provider.version}"\n    }\n  }\n}\n\nprovider "${provider.name}" {\n  # Configuration options\n}\n\`\`\`\n\n`;

		if (provider.docs && provider.docs.length > 0) {
			const categories = new Map<string, typeof provider.docs>();
			for (const doc of provider.docs) {
				const cat = doc.category || "other";
				if (!categories.has(cat)) categories.set(cat, []);
				categories.get(cat)!.push(doc);
			}

			md += `## Documentation\n\n`;
			for (const [category, docs] of categories) {
				md += `### ${category.charAt(0).toUpperCase() + category.slice(1)} (${docs.length})\n\n`;
				for (const doc of docs.slice(0, 15)) {
					md += `- ${markdownLink(doc.title, `https://registry.terraform.io/providers/${namespace}/${type}/latest/docs/${doc.category}/${doc.slug}`)}\n`;
				}
				if (docs.length > 15) {
					md += `\n[…${docs.length - 15} documents elided…]\n`;
				}
				md += "\n";
			}
		}

		return buildResult(md, {
			url: ctx.url,
			method: "terraform",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Terraform Registry API"],
		});
	},
};

// ============================================================================
// 27. VS Code Marketplace
// ============================================================================

interface MarketplaceProperty {
	key?: string;
	value?: string;
}

interface MarketplaceStatistic {
	statisticName?: string;
	value?: number;
}

interface MarketplaceExtension {
	extensionName?: string;
	displayName?: string;
	shortDescription?: string;
	description?: string;
	publisher?: { publisherName?: string; displayName?: string };
	versions?: Array<{ version?: string; properties?: MarketplaceProperty[] }>;
	statistics?: MarketplaceStatistic[];
	categories?: string[];
	tags?: string[];
	properties?: MarketplaceProperty[];
}

interface MarketplaceResponse {
	results?: Array<{ extensions?: MarketplaceExtension[] }>;
}

function toStatMap(stats: MarketplaceStatistic[] | undefined): Map<string, number> {
	const map = new Map<string, number>();
	if (!stats) return map;
	for (const stat of stats) {
		if (!stat.statisticName || typeof stat.value !== "number") continue;
		map.set(stat.statisticName.trim().toLowerCase(), stat.value);
	}
	return map;
}

function formatRating(averageRating?: number, ratingCount?: number): string | null {
	if (averageRating === undefined && ratingCount === undefined) return null;
	if (averageRating !== undefined) {
		const formatted = averageRating.toFixed(2).replace(/\.0+$/, "").replace(/\.$/, "");
		return ratingCount === undefined ? formatted : `${formatted} (${formatNumber(ratingCount)} ratings)`;
	}
	return ratingCount === undefined ? null : `${formatNumber(ratingCount)} ratings`;
}

function extractRepoLink(properties: MarketplaceProperty[] | undefined): string | null {
	if (!properties) return null;
	for (const prop of properties) {
		const key = prop.key?.trim().toLowerCase();
		const value = prop.value?.trim();
		if (!key || !value || !value.startsWith("http")) continue;
		if (key.includes("links.source") || key.includes("repository")) return value;
	}
	for (const prop of properties) {
		const key = prop.key?.trim().toLowerCase();
		const value = prop.value?.trim();
		if (!key || !value || !value.startsWith("http")) continue;
		if (key === "source" || key.endsWith(".source")) return value;
	}
	return null;
}

export const vscodeMarketplaceDeclaration: PackageRegistryDeclaration = {
	site: "vscode-marketplace",
	hosts: ["marketplace.visualstudio.com", "www.marketplace.visualstudio.com"],
	canonicalUrls: ["https://marketplace.visualstudio.com/items?itemName=ms-python.python"],
	match: parsed => {
		if (!parsed.pathname.startsWith("/items")) return null;
		const raw = parsed.searchParams.get("itemName");
		if (!raw) return null;
		const decoded = decodeURIComponent(raw);
		if (!decoded.includes(".")) return null;
		return { name: decoded, parsedUrl: parsed };
	},
	notes: ["Fetched via VS Code Marketplace API"],
	customFetch: async (match, ctx) => {
		const itemName = match.name;
		const [publisherFromUrl, ...nameParts] = itemName.split(".");
		const extensionFromUrl = nameParts.join(".");
		const result = await ctx.loadPage("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
			timeout: ctx.timeout,
			signal: ctx.signal,
			method: "POST",
			body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: itemName }] }], flags: 950 }),
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json;api-version=7.2-preview.1",
			},
		});
		if (!result.ok) return ctx.scraperDegrade("vscode-marketplace", ctx.loadFailure(result));

		const data = ctx.tryParseJson<MarketplaceResponse>(result.content);
		if (!data) return ctx.scraperDegrade("vscode-marketplace", "unexpected response shape");

		const extension = data.results?.[0]?.extensions?.[0];
		if (!extension) return null;

		const extensionName = extension.extensionName ?? extensionFromUrl;
		const displayName = extension.displayName ?? extensionName ?? itemName;
		const description = extension.shortDescription ?? extension.description;
		const publisherName = extension.publisher?.publisherName ?? publisherFromUrl;
		const publisherDisplayName = extension.publisher?.displayName;
		const publisherLabel =
			publisherDisplayName && publisherName && publisherDisplayName !== publisherName
				? `${publisherDisplayName} (${publisherName})`
				: (publisherDisplayName ?? publisherName);

		const version = extension.versions?.[0]?.version;
		const statMap = toStatMap(extension.statistics);
		const installs = statMap.get("install") ?? statMap.get("installs");
		const ratingLabel = formatRating(statMap.get("averagerating"), statMap.get("ratingcount"));
		const repoLink = extractRepoLink(extension.versions?.[0]?.properties) ?? extractRepoLink(extension.properties);
		const identifier = publisherName && extensionName ? `${publisherName}.${extensionName}` : itemName;

		let md = renderHeader(displayName, description);
		md += `**Identifier:** ${identifier}\n`;
		if (publisherLabel) md += `**Publisher:** ${publisherLabel}\n`;
		if (version) md += `**Version:** ${version}\n`;
		if (installs !== undefined) md += `**Installs:** ${formatNumber(installs)}\n`;
		if (ratingLabel) md += `**Rating:** ${ratingLabel}\n`;
		if (extension.categories?.length) md += `**Categories:** ${extension.categories.join(", ")}\n`;
		if (extension.tags?.length) md += `**Tags:** ${extension.tags.join(", ")}\n`;
		if (repoLink) md += `**Repository:** ${repoLink}\n`;

		return buildResult(md, {
			url: ctx.url,
			method: "vscode-marketplace",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via VS Code Marketplace API"],
		});
	},
};

export const PACKAGE_REGISTRY_DECLARATIONS = [
	artifacthubDeclaration,
	aurDeclaration,
	brewDeclaration,
	chocolateyDeclaration,
	clojarsDeclaration,
	cratesIoDeclaration,
	dockerhubDeclaration,
	fdroidDeclaration,
	firefoxAddonsDeclaration,
	flathubDeclaration,
	goPkgDeclaration,
	hackageDeclaration,
	hexDeclaration,
	jetbrainsMarketplaceDeclaration,
	mavenDeclaration,
	metacpanDeclaration,
	npmDeclaration,
	nugetDeclaration,
	openVsxDeclaration,
	packagistDeclaration,
	pubDevDeclaration,
	pypiDeclaration,
	repologyDeclaration,
	rubygemsDeclaration,
	snapcraftDeclaration,
	terraformDeclaration,
	vscodeMarketplaceDeclaration,
];
