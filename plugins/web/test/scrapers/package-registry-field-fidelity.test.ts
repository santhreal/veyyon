/**
 * WHY: shared section rendering can retain fields while changing blank lines,
 * counts, or truncation. Handler fixtures and list boundaries preserve these
 * contracts. This suite does not verify live upstream API availability.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { PACKAGE_REGISTRY_DECLARATIONS } from "../../src/scrapers/declarations/package-registries";
import { createPackageRegistryHandler } from "../../src/scrapers/engine/package-registry";
import * as scraperTypes from "../../src/scrapers/types";

describe("package registry field fidelity across all declared package registries", () => {
	let loadPageSpy: { mockRestore: () => void } | null = null;

	afterEach(() => {
		if (loadPageSpy) {
			loadPageSpy.mockRestore();
			loadPageSpy = null;
		}
	});

	it("exports all expected package registry declarations dynamically", () => {
		const declaredSites = PACKAGE_REGISTRY_DECLARATIONS.map(d => d.site);
		const expected = [
			"artifacthub",
			"aur",
			"brew",
			"chocolatey",
			"clojars",
			"crates-io",
			"dockerhub",
			"fdroid",
			"firefox-addons",
			"flathub",
			"go-pkg",
			"hackage",
			"hex",
			"jetbrains-marketplace",
			"maven",
			"metacpan",
			"npm",
			"nuget",
			"open-vsx",
			"packagist",
			"pub-dev",
			"pypi",
			"repology",
			"rubygems",
			"snapcraft",
			"terraform",
			"vscode-marketplace",
		];
		expect(declaredSites.sort()).toEqual(expected.sort());
	});

	// 1. Artifact Hub
	describe("artifacthub package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "artifacthub")!;
		const handler = createPackageRegistryHandler(decl, "handleArtifactHub");

		it("renders artifacthub package with badges, maintainers, security, links, install, versions, and readme", async () => {
			const fixture = {
				package_id: "pkg-123",
				name: "argo-cd",
				normalized_name: "argo-cd",
				display_name: "Sentinel Argo CD",
				description: "Sentinel Declarative GitOps CD for Kubernetes",
				version: "2.8.4",
				app_version: "v2.8.4",
				license: "Apache-2.0",
				home_url: "https://argo-cd.readthedocs.io",
				readme: "# Sentinel Argo CD README\n\nFull documentation content.",
				install: "helm repo add argo https://argoproj.github.io/argo-helm\nhelm install argo-cd argo/argo-cd",
				keywords: ["gitops", "kubernetes", "cd"],
				maintainers: [
					{ name: "Sentinel Maintainer Alice", email: "alice@example.com" },
					{ name: "Sentinel Maintainer Bob", email: "bob@example.com" },
				],
				links: [
					{ name: "Documentation", url: "https://argo-cd.readthedocs.io" },
					{ name: "GitHub", url: "https://github.com/argoproj/argo-cd" },
				],
				repository: {
					name: "argo-helm",
					display_name: "Sentinel Argo Helm Repo",
					url: "https://github.com/argoproj/argo-helm",
					organization_display_name: "Sentinel Argo Organization",
				},
				ts: 1690000000,
				created_at: 1600000000,
				stars: 12500,
				official: true,
				signed: true,
				security_report_summary: {
					critical: 0,
					high: 1,
					medium: 3,
					low: 5,
				},
				available_versions: [
					{ version: "2.8.4", ts: 1690000000 },
					{ version: "2.8.3", ts: 1689000000 },
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://artifacthub.io/api/v1/packages/helm/argo/argo-cd");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://artifacthub.io/packages/helm/argo/argo-cd",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("artifacthub");
			expect(result.content).toContain("# Sentinel Argo CD");
			expect(result.content).toContain("Sentinel Declarative GitOps CD for Kubernetes");
			expect(result.content).toContain(
				"**Type:** Helm Chart · **Version:** 2.8.4 · **App Version:** v2.8.4 · **License:** Apache-2.0",
			);
			expect(result.content).toContain("**Official · Signed · 13K stars**");
			expect(result.content).toContain(
				"**Repository:** Sentinel Argo Organization ([https://github.com/argoproj/argo-helm](https://github.com/argoproj/argo-helm))",
			);
			expect(result.content).toContain("**Homepage:** https://argo-cd.readthedocs.io");
			expect(result.content).toContain("**Keywords:** gitops, kubernetes, cd");
			expect(result.content).toContain("**Maintainers:** Sentinel Maintainer Alice, Sentinel Maintainer Bob");
			expect(result.content).toContain("**Security:** 1 high, 3 medium, 5 low");
			expect(result.content).toContain("## Links");
			expect(result.content).toContain("- [Documentation](https://argo-cd.readthedocs.io)");
			expect(result.content).toContain(
				"## Installation\n\n```bash\nhelm repo add argo https://argoproj.github.io/argo-helm\nhelm install argo-cd argo/argo-cd\n```",
			);
			expect(result.content).toContain("## Recent Versions\n\n- **2.8.4** (2023-07-22)\n- **2.8.3** (2023-07-10)");
			expect(result.content).toContain("---\n\n## README\n\n# Sentinel Argo CD README");
		});
	});

	// 2. Arch User Repository (AUR)
	describe("aur package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "aur")!;
		const handler = createPackageRegistryHandler(decl, "handleAur");

		it("renders aur package with votes, maintainer link, dependencies, and yay/manual installation", async () => {
			const fixture = {
				version: 5,
				type: "info",
				resultcount: 1,
				results: [
					{
						Name: "yay",
						Version: "12.3.5-1",
						Description: "Sentinel Yet another yogurt. Pacman wrapper and AUR helper written in go.",
						Maintainer: "sentinel_morganamilo",
						NumVotes: 2450,
						Popularity: 48.75,
						Depends: ["pacman>6.1", "git"],
						MakeDepends: ["go>=1.21"],
						OptDepends: ["sudo: privilege elevation"],
						CheckDepends: [],
						LastModified: 1700000000,
						FirstSubmitted: 1500000000,
						URL: "https://github.com/Jguer/yay",
						PackageBase: "yay",
						OutOfDate: 1705000000,
						License: ["GPL-3.0-or-later"],
						Keywords: ["aur", "helper", "pacman"],
						Provides: ["yay"],
						Conflicts: ["yay-bin"],
						Replaces: [],
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://aur.archlinux.org/rpc/?v=5&type=info&arg=yay");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://aur.archlinux.org/packages/yay", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("aur");
			expect(result.content).toContain("# yay");
			expect(result.content).toContain("Sentinel Yet another yogurt.");
			expect(result.content).toContain("**Version:** 12.3.5-1 (flagged out-of-date: 2024-01-11)");
			expect(result.content).toContain(
				"**Maintainer:** [sentinel_morganamilo](https://aur.archlinux.org/account/sentinel_morganamilo)",
			);
			expect(result.content).toContain("**Votes:** 2.5K · **Popularity:** 48.75");
			expect(result.content).toContain("**Last Updated:** 2023-11-14 · **First Submitted:** 2017-07-14");
			expect(result.content).toContain("**License:** GPL-3.0-or-later");
			expect(result.content).toContain("**Upstream:** https://github.com/Jguer/yay");
			expect(result.content).toContain("## Dependencies (2)\n\n- pacman>6.1\n- git");
			expect(result.content).toContain("## Make Dependencies (1)\n\n- go>=1.21");
			expect(result.content).toContain("## Optional Dependencies\n\n- sudo: privilege elevation");
			expect(result.content).toContain("## Provides\n\n- yay");
			expect(result.content).toContain("## Conflicts\n\n- yay-bin");
			expect(result.content).toContain("yay -S yay");
			expect(result.content).toContain("git clone https://aur.archlinux.org/yay.git");
		});
	});

	// 3. Homebrew
	describe("brew package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "brew")!;
		const handler = createPackageRegistryHandler(decl, "handleBrew");

		it("renders formula with 30d installs, dependencies, build dependencies, caveats, and brew install", async () => {
			const formulaFixture = {
				name: "ripgrep",
				full_name: "ripgrep",
				desc: "Sentinel Search tool like grep and The Silver Searcher",
				homepage: "https://github.com/BurntSushi/ripgrep",
				license: "Unlicense or MIT",
				versions: { stable: "14.1.0", head: "HEAD", bottle: true },
				dependencies: ["pcre2"],
				build_dependencies: ["rust", "pkg-config"],
				conflicts_with: [],
				caveats: "Sentinel Shell completions have been installed.",
				analytics: {
					install: {
						"30d": { arm64_sonoma: 50000, sonoma: 30000 },
					},
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://formulae.brew.sh/api/formula/ripgrep.json");
				return {
					content: JSON.stringify(formulaFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://formulae.brew.sh/formula/ripgrep", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# ripgrep");
			expect(result.content).toContain("Sentinel Search tool like grep and The Silver Searcher");
			expect(result.content).toContain("**Version:** 14.1.0 · **License:** Unlicense or MIT");
			expect(result.content).toContain("**Installs (30d):** 80K");
			expect(result.content).toContain("```bash\nbrew install ripgrep\n```");
			expect(result.content).toContain("**Homepage:** https://github.com/BurntSushi/ripgrep");
			expect(result.content).toContain("## Dependencies\n\n- pcre2");
			expect(result.content).toContain("## Build Dependencies\n\n- rust\n- pkg-config");
			expect(result.content).toContain("## Caveats\n\nSentinel Shell completions have been installed.");
		});

		it("renders cask with cask installation command", async () => {
			const caskFixture = {
				token: "visual-studio-code",
				name: ["Sentinel Visual Studio Code"],
				desc: "Sentinel Open-source code editor",
				homepage: "https://code.visualstudio.com/",
				version: "1.85.1",
				caveats: "Sentinel App is signed by Microsoft.",
				conflicts_with: { cask: ["visual-studio-code-insiders"] },
				analytics: {
					install: {
						"30d": { arm64_sonoma: 120000 },
					},
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://formulae.brew.sh/api/cask/visual-studio-code.json");
				return {
					content: JSON.stringify(caskFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://formulae.brew.sh/cask/visual-studio-code",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel Visual Studio Code");
			expect(result.content).toContain("```bash\nbrew install --cask visual-studio-code\n```");
			expect(result.content).toContain("**Installs (30d):** 120K");
			expect(result.content).toContain("## Conflicts With\n\n- visual-studio-code-insiders");
		});
	});

	// 4. Chocolatey
	describe("chocolatey package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "chocolatey")!;
		const handler = createPackageRegistryHandler(decl, "handleChocolatey");

		it("renders chocolatey package with version downloads, published date, tags, and dependencies", async () => {
			const fixture = {
				d: {
					results: [
						{
							Id: "git",
							Version: "2.43.0",
							Title: "Sentinel Git",
							Description: "Sentinel Fast, scalable, distributed revision control system.",
							Summary: "Sentinel Git is a fast version control system.",
							Authors: "Linus Torvalds, Junio C Hamano",
							ProjectUrl: "https://git-scm.com/",
							PackageSourceUrl: "https://github.com/chocolatey-community/chocolatey-packages",
							Tags: "git vcs distributed cli",
							DownloadCount: 45000000,
							VersionDownloadCount: 1200000,
							Published: "2023-11-20T10:00:00Z",
							LicenseUrl: "https://raw.githubusercontent.com/git/git/master/COPYING",
							ReleaseNotes: "Sentinel Release notes for Git 2.43.0.",
							Dependencies: "git.install:2.43.0|chocolatey-core.extension:1.1.0",
						},
					],
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://community.chocolatey.org/packages/git",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel Git");
			expect(result.content).toContain("Sentinel Git is a fast version control system.");
			expect(result.content).toContain("**Version:** 2.43.0 · **Authors:** Linus Torvalds, Junio C Hamano");
			expect(result.content).toContain("**Total Downloads:** 45M · **Version Downloads:** 1.2M");
			expect(result.content).toContain("**Published:** 2023-11-20");
			expect(result.content).toContain("**Project URL:** https://git-scm.com/");
			expect(result.content).toContain("**Source:** https://github.com/chocolatey-community/chocolatey-packages");
			expect(result.content).toContain("**License:** https://raw.githubusercontent.com/git/git/master/COPYING");
			expect(result.content).toContain("**Tags:** git, vcs, distributed, cli");
			expect(result.content).toContain("## Release Notes\n\nSentinel Release notes for Git 2.43.0.");
			expect(result.content).toContain(
				"## Dependencies\n\n- git.install: 2.43.0\n- chocolatey-core.extension: 1.1.0",
			);
			expect(result.content).toContain("**Install:** `choco install git`");
		});
	});

	// 5. Clojars
	describe("clojars package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "clojars")!;
		const handler = createPackageRegistryHandler(decl, "handleClojars");

		it("renders clojars artifact with group, artifact, licenses, downloads, and dependencies", async () => {
			const fixture = {
				group_name: "org.clojure",
				jar_name: "clojure",
				latest_version: "1.11.1",
				description: "Sentinel The Clojure programming language",
				downloads: 3500000,
				homepage: "https://clojure.org",
				licenses: [{ name: "Eclipse Public License 1.0", url: "https://opensource.org/licenses/eclipse-1.0.php" }],
				dependencies: [
					["org.clojure/spec.alpha", "0.3.218"],
					["org.clojure/core.specs.alpha", "0.2.62"],
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://clojars.org/api/artifacts/org.clojure/clojure");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://clojars.org/org.clojure/clojure", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# org.clojure/clojure");
			expect(result.content).toContain("Sentinel The Clojure programming language");
			expect(result.content).toContain("**Group:** org.clojure");
			expect(result.content).toContain("**Artifact:** clojure");
			expect(result.content).toContain("**Latest:** 1.11.1");
			expect(result.content).toContain("**Downloads:** 3.5M");
			expect(result.content).toContain("**Homepage:** https://clojure.org");
			expect(result.content).toContain(
				"**Licenses:** Eclipse Public License 1.0 (https://opensource.org/licenses/eclipse-1.0.php)",
			);
			expect(result.content).toContain(
				"## Dependencies\n\n- org.clojure/spec.alpha: 0.3.218\n- org.clojure/core.specs.alpha: 0.2.62",
			);
		});
	});

	// 6. Crates.io
	describe("crates-io package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "crates-io")!;
		const handler = createPackageRegistryHandler(decl, "handleCratesIo");

		it("renders crate with MSRV, total & recent downloads, categories, recent versions, and docs.rs readme", async () => {
			const crateFixture = {
				crate: {
					name: "serde",
					description: "Sentinel A generic serialization/deserialization framework",
					downloads: 250000000,
					recent_downloads: 15000000,
					max_version: "1.0.197",
					repository: "https://github.com/serde-rs/serde",
					homepage: "https://serde.rs",
					documentation: "https://docs.rs/serde",
					categories: ["encoding", "no-std"],
					keywords: ["serde", "serialization", "json"],
					created_at: "2015-05-13T07:08:12Z",
					updated_at: "2023-11-28T02:44:26Z",
				},
				versions: [
					{
						num: "1.0.197",
						downloads: 5000000,
						created_at: "2023-11-28T02:44:26Z",
						license: "MIT OR Apache-2.0",
						rust_version: "1.31",
					},
					{
						num: "1.0.196",
						downloads: 4000000,
						created_at: "2023-10-15T01:00:00Z",
						license: "MIT OR Apache-2.0",
						rust_version: "1.31",
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("crates.io")) {
					return {
						content: JSON.stringify(crateFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				if (url.includes("docs.rs")) {
					return {
						content:
							"# Sentinel Serde Readme from docs.rs\n\nSerde is a generic, high-performance framework for serializing and deserializing Rust data structures efficiently and generically.",
						contentType: "text/markdown",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: "", contentType: "text/plain", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler("https://crates.io/crates/serde", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# serde");
			expect(result.content).toContain("Sentinel A generic serialization/deserialization framework");
			expect(result.content).toContain("**Latest:** 1.0.197 · **License:** MIT OR Apache-2.0 · **MSRV:** 1.31");
			expect(result.content).toContain("**Downloads:** 250M total · 15M recent");
			expect(result.content).toContain("**Repository:** https://github.com/serde-rs/serde");
			expect(result.content).toContain("**Homepage:** https://serde.rs");
			expect(result.content).toContain("**Docs:** https://docs.rs/serde");
			expect(result.content).toContain("**Keywords:** serde, serialization, json");
			expect(result.content).toContain("**Categories:** encoding, no-std");
			expect(result.content).toContain("## Recent Versions\n\n- **1.0.197** (2023-11-28) - 5M downloads");
			expect(result.content).toContain("---\n\n## README\n\n# Sentinel Serde Readme from docs.rs");
		});
	});

	// 7. Docker Hub
	describe("dockerhub package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "dockerhub")!;
		const handler = createPackageRegistryHandler(decl, "handleDockerHub");

		it("renders dockerhub repository with parallel tags table, pulls, stars, and official badges", async () => {
			const repoFixture = {
				name: "nginx",
				namespace: "library",
				description: "Sentinel Official build of Nginx.",
				star_count: 19500,
				pull_count: 10000000000,
				last_updated: "2024-01-10T12:00:00Z",
				is_official: true,
				is_automated: false,
			};

			const tagsFixture = {
				results: [
					{
						name: "latest",
						last_updated: "2024-01-10T12:00:00Z",
						full_size: 70000000,
						images: [
							{ architecture: "amd64", os: "linux" },
							{ architecture: "arm64", os: "linux" },
						],
					},
					{
						name: "alpine",
						last_updated: "2024-01-09T10:00:00Z",
						full_size: 25000000,
						images: [{ architecture: "amd64", os: "linux" }],
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/tags/")) {
					return {
						content: JSON.stringify(tagsFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(repoFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://hub.docker.com/_/nginx", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# nginx");
			expect(result.content).toContain("Sentinel Official build of Nginx.");
			expect(result.content).toContain("**Pulls:** 10B · **Stars:** 20K · **Official Image**");
			expect(result.content).toContain("**Last Updated:** 2024-01-10");
			expect(result.content).toContain("```bash\ndocker pull nginx\n```");
			expect(result.content).toContain("## Recent Tags");
			expect(result.content).toContain("| `latest` | 66.8MB | amd64, arm64 | 2024-01-10 |");
			expect(result.content).toContain("| `alpine` | 23.8MB | amd64 | 2024-01-09 |");
		});
	});

	// 8. F-Droid
	describe("fdroid package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "fdroid")!;
		const handler = createPackageRegistryHandler(decl, "handleFdroid");

		it("renders fdroid app with localized metadata, author email, anti-features, source, and version history", async () => {
			const fixture = {
				packageName: "org.mozilla.fennec_fdroid",
				name: { "en-US": "Sentinel Fennec F-Droid" },
				summary: { "en-US": "Sentinel Browse the web" },
				description: { "en-US": "Sentinel Detailed description of Fennec browser." },
				authorName: "Sentinel Mozilla Community",
				authorEmail: "fennec@example.com",
				license: "MPL-2.0",
				categories: ["Internet", "Security"],
				antiFeatures: ["NonFreeNet"],
				sourceCode: "https://github.com/mozilla-mobile/fenix",
				packages: [
					{ versionName: "121.0", versionCode: 1210000 },
					{ versionName: "120.0", versionCode: 1200000 },
				],
				suggestedVersionName: "121.0",
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://f-droid.org/api/v1/packages/org.mozilla.fennec_fdroid");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://f-droid.org/packages/org.mozilla.fennec_fdroid/",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel Fennec F-Droid");
			expect(result.content).toContain("Sentinel Browse the web");
			expect(result.content).toContain(
				"**Package:** org.mozilla.fennec_fdroid · **Latest:** 121.0 · **License:** MPL-2.0",
			);
			expect(result.content).toContain("**Author:** Sentinel Mozilla Community <fennec@example.com>");
			expect(result.content).toContain("**Source Code:** https://github.com/mozilla-mobile/fenix");
			expect(result.content).toContain("**Categories:** Internet, Security");
			expect(result.content).toContain("**Anti-Features:** NonFreeNet");
			expect(result.content).toContain("## Description\n\nSentinel Detailed description of Fennec browser.");
			expect(result.content).toContain("## Version History\n\n- 121.0 (1210000)\n- 120.0 (1200000)");
		});
	});

	// 9. Firefox Add-ons (AMO)
	describe("firefox-addons package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "firefox-addons")!;
		const handler = createPackageRegistryHandler(decl, "handleFirefoxAddons");

		it("renders firefox addon with ratings, user count, permissions, and markdown description", async () => {
			const fixture = {
				name: { "en-US": "Sentinel uBlock Origin" },
				summary: { "en-US": "Sentinel An efficient wide-spectrum content blocker." },
				description: { "en-US": "<p>Sentinel An <strong>efficient</strong> blocker for Firefox.</p>" },
				default_locale: "en-US",
				authors: [{ name: "Raymond Hill (gorhill)" }],
				average_daily_users: 6500000,
				ratings: { average: 4.85, count: 18200 },
				current_version: {
					version: "1.55.0",
					license: {
						name: { "en-US": "GPL-3.0" },
						url: "https://www.gnu.org/licenses/gpl-3.0.html",
					},
					file: {
						permissions: ["storage", "tabs", "webNavigation"],
						host_permissions: ["<all_urls>"],
					},
				},
				categories: ["privacy-security"],
				homepage: { url: { "en-US": "https://github.com/gorhill/uBlock" } },
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: "https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/?src=redirect",
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel uBlock Origin");
			expect(result.content).toContain("Sentinel An efficient wide-spectrum content blocker.");
			expect(result.content).toContain("**Author:** Raymond Hill (gorhill)");
			expect(result.content).toContain("**Rating:** 4.85 (18K reviews)");
			expect(result.content).toContain("**Users:** 6.5M");
			expect(result.content).toContain("**Version:** 1.55.0");
			expect(result.content).toContain("**Categories:** privacy-security");
			expect(result.content).toContain("**License:** [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)");
			expect(result.content).toContain("**Homepage:** https://github.com/gorhill/uBlock");
			expect(result.content).toContain("## Permissions (4)\n\n- storage\n- tabs\n- webNavigation\n- <all_urls>");
			expect(result.finalUrl).toBe("https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/?src=redirect");
			expect(result.url).toBe("https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/");
		});
	});

	// 10. Flathub
	describe("flathub package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "flathub")!;
		const handler = createPackageRegistryHandler(decl, "handleFlathub");

		it("renders flathub app with metadata, permissions, screenshots, and releases", async () => {
			const fixture = {
				id: "org.gimp.GIMP",
				name: "Sentinel GIMP",
				summary: "Sentinel Create images and edit photographs",
				description: "<p>Sentinel GIMP is an advanced image editor.</p>",
				developer_name: "The GIMP Team",
				categories: ["Graphics", "Photography"],
				installs: 5400000,
				permissions: ["pulseaudio", "x11", "ipc"],
				screenshots: [
					{
						caption: "Main Window",
						sizes: [
							{ src: "https://dl.flathub.org/gimp-thumb.png", width: "400", height: "300" },
							{ src: "https://dl.flathub.org/gimp-full.png", width: "1920", height: "1080" },
						],
					},
				],
				releases: [
					{
						version: "2.10.36",
						timestamp: "1700000000",
						type: "stable",
						description: "<p>Bug fixes and stability improvements.</p>",
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://flathub.org/api/v2/appstream/org.gimp.GIMP");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: "https://flathub.org/api/v2/appstream/org.gimp.GIMP?redirected=true",
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://flathub.org/apps/org.gimp.GIMP", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel GIMP");
			expect(result.content).toContain("Sentinel Create images and edit photographs");
			expect(result.content).toContain("**App ID:** org.gimp.GIMP");
			expect(result.content).toContain("**Developer:** The GIMP Team");
			expect(result.content).toContain("**Installs:** 5.4M");
			expect(result.content).toContain("## Categories\n\n- Graphics\n- Photography");
			expect(result.content).toContain("## Permissions\n\n- pulseaudio\n- x11\n- ipc");
			expect(result.content).toContain("## Screenshots\n\n- https://dl.flathub.org/gimp-full.png - Main Window");
			expect(result.content).toContain("## Releases\n\n- **2.10.36** (2023-11-14) · stable");
			expect(result.finalUrl).toBe("https://flathub.org/api/v2/appstream/org.gimp.GIMP?redirected=true");
			expect(result.url).toBe("https://flathub.org/apps/org.gimp.GIMP");
		});
	});

	// 11. Go Package (pkg.go.dev)
	describe("go-pkg package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "go-pkg")!;
		const handler = createPackageRegistryHandler(decl, "handleGoPkg");

		it("renders go package with proxy info, synopsis, exported index, and imports", async () => {
			const proxyFixture = {
				Version: "v1.9.1",
				Time: "2023-09-01T12:00:00Z",
			};

			const htmlFixture = `<!DOCTYPE html>
<html>
<head><title>gin package - github.com/gin-gonic/gin - Go Packages</title></head>
<body>
<div class="go-Breadcrumb"><a href="/github.com/gin-gonic/gin">github.com/gin-gonic/gin</a></div>
<span class="go-Chip">v1.9.1</span>
<a data-test-id="UnitHeader-license">MIT</a>
<input data-test-id="UnitHeader-importPath" value="github.com/gin-gonic/gin" />
<div class="go-Main-headerContent"><p>Sentinel Gin is a HTTP web framework written in Go.</p></div>
<div id="section-documentation">
	<div class="go-Message"><p>Package gin implements a high performance HTTP router.</p></div>
	<div class="Documentation-content"><p>Sentinel Detailed overview of Gin engine usage.</p></div>
</div>
<div id="section-index">
	<ul class="Documentation-indexList">
		<li><a href="#Default">Default</a></li>
		<li><a href="#New">New</a></li>
		<li><a href="#Engine">Engine</a></li>
	</ul>
</div>
<div id="section-imports">
	<div class="go-Message">
		<a href="/net/http">net/http</a>
		<a href="/github.com/gin-contrib/sse">github.com/gin-contrib/sse</a>
	</div>
</div>
</body>
</html>`;

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("proxy.golang.org")) {
					return {
						content: JSON.stringify(proxyFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: htmlFixture, contentType: "text/html", finalUrl: url, ok: true, status: 200 };
			});

			const result = (await handler("https://pkg.go.dev/github.com/gin-gonic/gin", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# github.com/gin-gonic/gin");
			expect(result.content).toContain("**Module:** github.com/gin-gonic/gin");
			expect(result.content).toContain("**Version:** v1.9.1");
			expect(result.content).toContain("**License:** MIT");
			expect(result.content).toContain("## Synopsis\n\nSentinel Gin is a HTTP web framework written in Go.");
			expect(result.content).toContain("## Documentation");
			expect(result.content).toContain("Package gin implements a high performance HTTP router.");
			expect(result.content).toContain("## Index\n\n- Default\n- New\n- Engine");
			expect(result.content).toContain("## Imports\n\n- net/http\n- github.com/gin-contrib/sse");
			expect(result.notes).toContain("published 2023-09-01T12:00:00Z");
		});
	});

	// 12. Hackage
	describe("hackage package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "hackage")!;
		const handler = createPackageRegistryHandler(decl, "handleHackage");

		it("renders hackage package by parsing .cabal file metadata", async () => {
			const versionMap = { "2.0.0.0": "normal", "2.0.1.0": "normal" };
			const cabalText = `name: aeson
version: 2.0.1.0
synopsis: Sentinel Fast JSON parsing and encoding
description:
  Sentinel Aeson is a high-performance JSON library for Haskell.
  It supports automatic derivation of ToJSON and FromJSON instances.
license: BSD-3-Clause
author: Bryan O'Sullivan <bos@serpentine.com>
maintainer: Adam Bergmark <adam@bergmark.nl>
homepage: https://github.com/haskell/aeson
bug-reports: https://github.com/haskell/aeson/issues
category: JSON, Web, Parsing
stability: experimental
`;

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.endsWith(".json")) {
					return {
						content: JSON.stringify(versionMap),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: cabalText, contentType: "text/plain", finalUrl: url, ok: true, status: 200 };
			});

			const result = (await handler("https://hackage.haskell.org/package/aeson", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# aeson");
			expect(result.content).toContain("Sentinel Fast JSON parsing and encoding");
			expect(result.content).toContain("**Version:** 2.0.1.0 · **License:** BSD-3-Clause");
			expect(result.content).toContain("**Author:** Bryan O'Sullivan <bos@serpentine.com>");
			expect(result.content).toContain("**Maintainer:** Adam Bergmark <adam@bergmark.nl>");
			expect(result.content).toContain("**Category:** JSON, Web, Parsing");
			expect(result.content).toContain("**Stability:** experimental");
			expect(result.content).toContain("**Homepage:** https://github.com/haskell/aeson");
			expect(result.content).toContain("**Bug Reports:** https://github.com/haskell/aeson/issues");
			expect(result.content).toContain(
				"## Description\n\nSentinel Aeson is a high-performance JSON library for Haskell.\nIt supports automatic derivation of ToJSON and FromJSON instances.",
			);
		});
	});

	// 13. Hex.pm
	describe("hex package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "hex")!;
		const handler = createPackageRegistryHandler(decl, "handleHex");

		it("renders hex package with releases, dependencies, weekly downloads, and links", async () => {
			const packageFixture = {
				name: "phoenix",
				meta: {
					description: "Sentinel Productive web framework for Elixir",
					licenses: ["MIT"],
					links: {
						GitHub: "https://github.com/phoenixframework/phoenix",
						Homepage: "https://www.phoenixframework.org",
					},
				},
				latest_version: "1.7.10",
				latest_stable_version: "1.7.10",
				downloads: {
					all: 12500000,
					week: 145000,
				},
				releases: [
					{ version: "1.7.10", inserted_at: "2023-11-20T15:30:00Z" },
					{ version: "1.7.9", inserted_at: "2023-10-10T12:00:00Z" },
				],
			};

			const releaseFixture = {
				requirements: {
					plug: { requirement: "~> 1.14", optional: false },
					telemetry: { requirement: "~> 1.0", optional: true },
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/releases/")) {
					return {
						content: JSON.stringify(releaseFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(packageFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://hex.pm/packages/phoenix", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# phoenix");
			expect(result.content).toContain("Sentinel Productive web framework for Elixir");
			expect(result.content).toContain("**Latest:** 1.7.10 · **License:** MIT");
			expect(result.content).toContain("**Total Downloads:** 13M · **This Week:** 145K");
			expect(result.content).toContain(
				"## Links\n\n- **GitHub:** https://github.com/phoenixframework/phoenix\n- **Homepage:** https://www.phoenixframework.org",
			);
			expect(result.content).toContain(
				"## Dependencies (1.7.10)\n\n- plug: ~> 1.14\n- telemetry: ~> 1.0 (optional)",
			);
			expect(result.content).toContain("## Recent Releases\n\n- **1.7.10** (2023-11-20)\n- **1.7.9** (2023-10-10)");
		});
	});

	// 14. JetBrains Marketplace
	describe("jetbrains-marketplace package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "jetbrains-marketplace")!;
		const handler = createPackageRegistryHandler(decl, "handleJetBrainsMarketplace");

		it("renders jetbrains plugin with vendor, rating votes, latest release, and IDE compatibility", async () => {
			const pluginFixture = {
				id: 1347,
				name: "Sentinel Scala",
				description: "<p>Sentinel Scala language support for IntelliJ IDEA.</p>",
				vendor: { name: "JetBrains" },
				downloads: 14500000,
				rating: { rating: 4.65, count: 850 },
				tags: [{ name: "Languages" }, { name: "Tools" }],
			};

			const updatesFixture = [
				{
					version: "2023.3.15",
					channel: "Stable",
					since: "233.11799",
					until: "233.*",
					downloads: 85000,
					compatibleVersions: {
						"IntelliJ IDEA": "2023.3+",
						"Android Studio": "Iguana+",
					},
				},
			];

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/updates")) {
					return {
						content: JSON.stringify(updatesFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(pluginFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://plugins.jetbrains.com/plugin/1347-scala",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel Scala");
			expect(result.content).toContain("Sentinel Scala language support for IntelliJ IDEA.");
			expect(result.content).toContain("**Plugin ID:** 1347");
			expect(result.content).toContain("**Vendor:** JetBrains");
			expect(result.content).toContain("**Downloads:** 15M");
			expect(result.content).toContain("**Rating:** 4.65 (850 votes)");
			expect(result.content).toContain("**Tags:** Languages, Tools");
			expect(result.content).toContain(
				"## Latest Release\n\n**Version:** 2023.3.15\n**Channel:** Stable\n**Build Compatibility:** 233.11799 - 233.*\n**Release Downloads:** 85K",
			);
			expect(result.content).toContain(
				"## IDE Compatibility\n\n- Android Studio: Iguana+\n- IntelliJ IDEA: 2023.3+",
			);
		});
	});

	// 15. Maven Central
	describe("maven package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "maven")!;
		const handler = createPackageRegistryHandler(decl, "handleMaven");

		it("renders maven artifact with XML, Gradle Groovy, and Kotlin DSL dependency snippets", async () => {
			const fixture = {
				response: {
					numFound: 1,
					docs: [
						{
							id: "com.google.guava:guava",
							g: "com.google.guava",
							a: "guava",
							latestVersion: "33.0.0-jre",
							repositoryId: "central",
							p: "jar",
							timestamp: 1705000000000,
							versionCount: 120,
							ec: ["-sources.jar", "-javadoc.jar"],
						},
					],
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toContain("q=g:com.google.guava+AND+a:guava");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://search.maven.org/artifact/com.google.guava/guava",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# com.google.guava:guava");
			expect(result.content).toContain("**Group ID:** com.google.guava");
			expect(result.content).toContain("**Artifact ID:** guava");
			expect(result.content).toContain("**Latest Version:** 33.0.0-jre");
			expect(result.content).toContain("**Packaging:** jar");
			expect(result.content).toContain("**Versions:** 120");
			expect(result.content).toContain("**Last Updated:** 2024-01-11");
			expect(result.content).toContain(
				"## Maven Dependency\n\n```xml\n<dependency>\n    <groupId>com.google.guava</groupId>\n    <artifactId>guava</artifactId>\n    <version>33.0.0-jre</version>\n</dependency>\n```",
			);
			expect(result.content).toContain(
				"## Gradle Dependency\n\n```groovy\nimplementation 'com.google.guava:guava:33.0.0-jre'\n```",
			);
			expect(result.content).toContain(
				'## Gradle (Kotlin DSL)\n\n```kotlin\nimplementation("com.google.guava:guava:33.0.0-jre")\n```',
			);
			expect(result.content).toContain("## Available Extensions\n\n- -sources.jar\n- -javadoc.jar");
		});
	});

	// 16. MetaCPAN
	describe("metacpan package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "metacpan")!;
		const handler = createPackageRegistryHandler(decl, "handleMetaCPAN");

		it("renders metacpan module with release metadata and runtime dependencies", async () => {
			const moduleFixture = {
				name: "Moose",
				version: "2.2206",
				abstract: "Sentinel A postmodern object system for Perl 5",
				author: "ETHER",
				distribution: "Moose",
				release: "Moose-2.2206",
				path: "lib/Moose.pm",
			};

			const releaseFixture = {
				name: "Moose-2.2206",
				version: "2.2206",
				author: "ETHER",
				distribution: "Moose",
				license: ["perl_5"],
				stat: { mtime: 1698000000 },
				dependency: [
					{ module: "Carp", version: "1.22", phase: "runtime", relationship: "requires" },
					{ module: "Class::Load", version: "0.09", phase: "runtime", relationship: "requires" },
				],
				metadata: {
					resources: {
						repository: { url: "git://github.com/moose/Moose.git", web: "https://github.com/moose/Moose" },
						homepage: "https://metacpan.org/pod/Moose",
						bugtracker: { web: "https://github.com/moose/Moose/issues" },
					},
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/module/")) {
					return {
						content: JSON.stringify(moduleFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(releaseFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://metacpan.org/pod/Moose", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Moose");
			expect(result.content).toContain("Sentinel A postmodern object system for Perl 5");
			expect(result.content).toContain(
				"**Version:** 2.2206 · **Distribution:** Moose · **Author:** [ETHER](https://metacpan.org/author/ETHER)",
			);
			expect(result.content).toContain("**License:** perl_5");
			expect(result.content).toContain("**Repository:** https://github.com/moose/Moose");
			expect(result.content).toContain("**Homepage:** https://metacpan.org/pod/Moose");
			expect(result.content).toContain("**Issues:** https://github.com/moose/Moose/issues");
			expect(result.content).toContain("## Dependencies\n\n- **Carp** >= 1.22\n- **Class::Load** >= 0.09");
			expect(result.content).toContain("## Installation\n\n```bash\ncpanm Moose\n```");
		});
	});

	// 17. NPM
	describe("npm package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "npm")!;
		const handler = createPackageRegistryHandler(decl, "handleNpm");

		it("renders npm package with /latest endpoint and parallel weekly downloads", async () => {
			const pkgFixture = {
				name: "express",
				version: "4.18.2",
				description: "Sentinel Fast, unopinionated, minimalist web framework",
				license: "MIT",
				homepage: "http://expressjs.com/",
				repository: { url: "git+https://github.com/expressjs/express.git" },
				keywords: ["express", "framework", "sinatra", "web", "rest"],
				maintainers: [{ name: "dougwilson" }, { name: "wesleytodd" }],
				dependencies: {
					accepts: "~1.3.8",
					"array-flatten": "1.1.1",
				},
				readme: "# Sentinel Express README\n\nFast, unopinionated, minimalist web framework for node.",
			};

			const dlFixture = {
				downloads: 28500000,
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("api.npmjs.org/downloads")) {
					return {
						content: JSON.stringify(dlFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(pkgFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://www.npmjs.com/package/express", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# express");
			expect(result.content).toContain("Sentinel Fast, unopinionated, minimalist web framework");
			expect(result.content).toContain("**Latest:** 4.18.2 · **License:** MIT");
			expect(result.content).toContain("**Weekly Downloads:** 29M");
			expect(result.content).toContain("**Homepage:** http://expressjs.com/");
			expect(result.content).toContain("**Repository:** https://github.com/expressjs/express");
			expect(result.content).toContain("**Keywords:** express, framework, sinatra, web, rest");
			expect(result.content).toContain("**Maintainers:** dougwilson, wesleytodd");
			expect(result.content).toContain("## Dependencies\n\n- accepts: ~1.3.8\n- array-flatten: 1.1.1");
			expect(result.content).toContain("---\n\n## README\n\n# Sentinel Express README");
		});
	});

	// 18. NuGet
	describe("nuget package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "nuget")!;
		const handler = createPackageRegistryHandler(decl, "handleNuGet");

		it("renders nuget package with framework dependencies, total downloads, and recent versions", async () => {
			const regFixture = {
				items: [
					{
						items: [
							{
								catalogEntry: {
									id: "Newtonsoft.Json",
									version: "13.0.3",
									description: "Sentinel Json.NET is a popular high-performance JSON framework for .NET",
									authors: "James Newton-King",
									projectUrl: "https://www.newtonsoft.com/json",
									licenseExpression: "MIT",
									tags: ["json"],
									published: "2023-03-08T00:00:00Z",
									dependencyGroups: [
										{
											targetFramework: ".NETStandard2.0",
											dependencies: [{ id: "Microsoft.CSharp", range: "[4.3.0, )" }],
										},
									],
								},
							},
						],
					},
				],
			};

			const searchFixture = {
				data: [{ totalDownloads: 1200000000 }],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/query?")) {
					return {
						content: JSON.stringify(searchFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(regFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://www.nuget.org/packages/Newtonsoft.Json/",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Newtonsoft.Json");
			expect(result.content).toContain("Sentinel Json.NET is a popular high-performance JSON framework for .NET");
			expect(result.content).toContain("**Version:** 13.0.3 · **License:** MIT");
			expect(result.content).toContain("**Total Downloads:** 1.2B");
			expect(result.content).toContain("**Authors:** James Newton-King");
			expect(result.content).toContain("**Project URL:** https://www.newtonsoft.com/json");
			expect(result.content).toContain("**Tags:** json");
			expect(result.content).toContain("**Published:** 2023-03-08");
			expect(result.content).toContain("## Dependencies\n\n### .NETStandard2.0\n\n- Microsoft.CSharp ([4.3.0, ))");
		});
	});

	// 19. Open VSX
	describe("open-vsx package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "open-vsx")!;
		const handler = createPackageRegistryHandler(decl, "handleOpenVsx");

		it("renders open-vsx extension with namespace, downloads, rating with review count, and readme fetch", async () => {
			const extFixture = {
				name: "rust-analyzer",
				namespace: "rust-lang",
				version: "0.4.1800",
				displayName: "Sentinel Rust Analyzer",
				description: "Sentinel Rust language support for VS Code",
				downloadCount: 1850000,
				averageRating: 4.92,
				reviewCount: 340,
				repository: "https://github.com/rust-lang/rust-analyzer",
				license: "MIT OR Apache-2.0",
				categories: ["Programming Languages"],
				homepage: "https://rust-analyzer.github.io/",
				files: {
					readme: "https://open-vsx.org/files/rust-lang/rust-analyzer/readme.md",
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/readme.md")) {
					return {
						content: "# Sentinel Rust Analyzer Readme\n\nLanguage server for Rust.",
						contentType: "text/markdown",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(extFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://open-vsx.org/extension/rust-lang/rust-analyzer",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel Rust Analyzer");
			expect(result.content).toContain("Sentinel Rust language support for VS Code");
			expect(result.content).toContain("**Namespace:** rust-lang");
			expect(result.content).toContain("**Extension:** rust-analyzer");
			expect(result.content).toContain("**Version:** 0.4.1800 | **License:** MIT OR Apache-2.0");
			expect(result.content).toContain("**Downloads:** 1.9M");
			expect(result.content).toContain("**Rating:** 4.92 (340 reviews)");
			expect(result.content).toContain("**Repository:** https://github.com/rust-lang/rust-analyzer");
			expect(result.content).toContain("**Homepage:** https://rust-analyzer.github.io/");
			expect(result.content).toContain("**Categories:** Programming Languages");
			expect(result.content).toContain("---\n\n## README\n\n# Sentinel Rust Analyzer Readme");
		});
	});

	// 20. Packagist (PHP)
	describe("packagist package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "packagist")!;
		const handler = createPackageRegistryHandler(decl, "handlePackagist");

		it("renders packagist package with stable version resolution, downloads, GitHub stats, and dev requirements", async () => {
			const fixture = {
				package: {
					name: "laravel/framework",
					description: "Sentinel The Laravel Framework.",
					time: "2023-12-01T00:00:00Z",
					maintainers: [{ name: "taylorotwell" }],
					type: "library",
					repository: "https://github.com/laravel/framework",
					github_stars: 32000,
					github_forks: 10500,
					github_open_issues: 45,
					downloads: {
						total: 350000000,
						monthly: 15000000,
						daily: 500000,
					},
					favers: 32000,
					versions: {
						"dev-master": { name: "laravel/framework", version: "dev-master", time: "2024-01-01T00:00:00Z" },
						"v10.35.0": {
							name: "laravel/framework",
							version: "v10.35.0",
							license: ["MIT"],
							time: "2023-12-05T14:00:00Z",
							homepage: "https://laravel.com",
							authors: [{ name: "Taylor Otwell", email: "taylor@laravel.com" }],
							require: {
								php: "^8.1.0",
								"league/flysystem": "^3.8.0",
							},
							"require-dev": {
								phpunit: "^10.0",
							},
						},
					},
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://packagist.org/packages/laravel/framework.json");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://packagist.org/packages/laravel/framework",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# laravel/framework");
			expect(result.content).toContain("Sentinel The Laravel Framework.");
			expect(result.content).toContain("**Latest:** v10.35.0 · **License:** MIT · **Type:** library");
			expect(result.content).toContain("**Downloads:** 350M total · 15M/month");
			expect(result.content).toContain("**Stars:** 32K");
			expect(result.content).toContain("**Authors:** Taylor Otwell <taylor@laravel.com>");
			expect(result.content).toContain("**Maintainers:** taylorotwell");
			expect(result.content).toContain("**Homepage:** https://laravel.com");
			expect(result.content).toContain("**Repository:** https://github.com/laravel/framework");
			expect(result.content).toContain("**GitHub:** 32K stars · 11K forks · 45 open issues");
			expect(result.content).toContain("## Requirements\n\n- php: ^8.1.0\n- league/flysystem: ^3.8.0");
			expect(result.content).toContain("## Dev Requirements\n\n- phpunit: ^10.0");
		});
	});

	// 21. Pub.dev (Dart/Flutter)
	describe("pub-dev package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "pub-dev")!;
		const handler = createPackageRegistryHandler(decl, "handlePubDev");

		it("renders pub.dev package with metrics, SDK constraints, dependencies, and HTML readme", async () => {
			const pkgFixture = {
				name: "flutter_bloc",
				latest: {
					version: "8.1.3",
					pubspec: {
						description: "Sentinel Flutter Widgets that make it easy to implement BLoC design pattern.",
						homepage: "https://bloclibrary.dev",
						repository: "https://github.com/felangel/bloc",
						documentation: "https://bloclibrary.dev",
						environment: {
							sdk: ">=2.14.0 <4.0.0",
							flutter: ">=3.0.0",
						},
						dependencies: {
							bloc: "^8.1.2",
							flutter: "complex",
						},
					},
				},
				publisherId: "bloclibrary.dev",
				metrics: {
					score: {
						likeCount: 4800,
						grantedPoints: 140,
						maxPoints: 140,
						popularityScore: 0.99,
					},
				},
			};

			const readmeHtml = `<div class="markdown-body">
<h1>Sentinel Flutter BLoC Readme</h1>
<p>A predictable state management library for Flutter.</p>
<p>More detailed usage guide and examples here.</p>
</div>`;

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/readme")) {
					return { content: readmeHtml, contentType: "text/html", finalUrl: url, ok: true, status: 200 };
				}
				return {
					content: JSON.stringify(pkgFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://pub.dev/packages/flutter_bloc", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# flutter_bloc");
			expect(result.content).toContain(
				"Sentinel Flutter Widgets that make it easy to implement BLoC design pattern.",
			);
			expect(result.content).toContain("**Latest:** 8.1.3 · **Publisher:** bloclibrary.dev");
			expect(result.content).toContain("**Likes:** 4.8K · **Pub Points:** 140/140 · **Popularity:** 99%");
			expect(result.content).toContain("**Homepage:** https://bloclibrary.dev");
			expect(result.content).toContain("**Repository:** https://github.com/felangel/bloc");
			expect(result.content).toContain("**Documentation:** https://bloclibrary.dev");
			expect(result.content).toContain("**SDK:** sdk: >=2.14.0 <4.0.0, flutter: >=3.0.0");
			expect(result.content).toContain("## Dependencies (2)\n\n- bloc: ^8.1.2\n- flutter: complex");
			expect(result.content).toContain("## README\n\n# Sentinel Flutter BLoC Readme");
		});
	});

	// 22. PyPI (Python)
	describe("pypi package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "pypi")!;
		const handler = createPackageRegistryHandler(decl, "handlePyPI");

		it("renders pypi package with pypistats downloads, author email, python version, and project urls", async () => {
			const pypiFixture = {
				info: {
					name: "requests",
					version: "2.31.0",
					summary: "Sentinel Python HTTP for Humans.",
					description: "Sentinel Requests is an elegant and simple HTTP library for Python.",
					author: "Kenneth Reitz",
					author_email: "me@kennethreitz.org",
					license: "Apache 2.0",
					home_page: "https://requests.readthedocs.io",
					project_urls: {
						Documentation: "https://requests.readthedocs.io",
						Source: "https://github.com/psf/requests",
					},
					requires_python: ">=3.7",
					keywords: "http, rest, client",
				},
				requires_dist: ["charset-normalizer (<4,>=2)", "idna (<4,>=2.5)", "urllib3 (<3,>=1.21.1)"],
			};

			const statsFixture = {
				data: { last_week: 42000000 },
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("pypistats.org")) {
					return {
						content: JSON.stringify(statsFixture),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: JSON.stringify(pypiFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://pypi.org/project/requests/", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# requests");
			expect(result.content).toContain("Sentinel Python HTTP for Humans.");
			expect(result.content).toContain("**Latest:** 2.31.0 · **License:** Apache 2.0");
			expect(result.content).toContain("**Weekly Downloads:** 42M");
			expect(result.content).toContain("**Author:** Kenneth Reitz <me@kennethreitz.org>");
			expect(result.content).toContain("**Python:** >=3.7");
			expect(result.content).toContain("**Homepage:** https://requests.readthedocs.io");
			expect(result.content).toContain(
				"**Project URLs:**\n- Documentation: https://requests.readthedocs.io\n- Source: https://github.com/psf/requests",
			);
			expect(result.content).toContain("**Keywords:** http, rest, client");
			expect(result.content).toContain(
				"## Dependencies\n\n- charset-normalizer (<4,>=2)\n- idna (<4,>=2.5)\n- urllib3 (<3,>=1.21.1)",
			);
			expect(result.content).toContain(
				"---\n\n## Description\n\nSentinel Requests is an elegant and simple HTTP library for Python.",
			);
		});
	});

	// 23. Repology
	describe("repology package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "repology")!;
		const handler = createPackageRegistryHandler(decl, "handleRepology");

		it("renders repology project with status summary emoji and sorted distro table", async () => {
			const fixture = [
				{
					repo: "arch",
					srcname: "ripgrep",
					version: "14.1.0",
					status: "newest",
					summary: "Sentinel Fast line-oriented search tool",
					categories: ["sysutils"],
					licenses: ["MIT", "Unlicense"],
				},
				{
					repo: "debian_stable",
					srcname: "rust-ripgrep",
					version: "13.0.0-4",
					status: "outdated",
					summary: "Sentinel Fast line-oriented search tool",
				},
				{
					repo: "fedora_rawhide",
					srcname: "rust-ripgrep",
					version: "14.1.0",
					status: "newest",
				},
			];

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://repology.org/api/v1/project/ripgrep");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://repology.org/project/ripgrep", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# ripgrep");
			expect(result.content).toContain("Sentinel Fast line-oriented search tool");
			expect(result.content).toContain("**Newest Version:** 14.1.0");
			expect(result.content).toContain("**Repositories:** 3");
			expect(result.content).toContain("**License:** MIT, Unlicense");
			expect(result.content).toContain("**Categories:** sysutils");
			expect(result.content).toContain(
				"## Version Status Summary\n\n- ✅ **newest**: 2 repos\n- 🔴 **outdated**: 1 repos",
			);
			expect(result.content).toContain("## Package Versions by Repository");
			expect(result.content).toContain("| Arch Linux | `14.1.0` | ✅ newest |");
			expect(result.content).toContain("| Fedora Rawhide | `14.1.0` | ✅ newest |");
			expect(result.content).toContain("| Debian Stable | `13.0.0-4` | 🔴 outdated |");
			expect(result.content).toContain("[View on Repology](https://repology.org/project/ripgrep)");
		});
	});

	// 24. RubyGems
	describe("rubygems package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "rubygems")!;
		const handler = createPackageRegistryHandler(decl, "handleRubyGems");

		it("renders rubygems gem with version downloads, runtime deps, and dev deps", async () => {
			const fixture = {
				name: "rails",
				version: "7.1.2",
				info: "Sentinel Ruby on Rails is a full-stack web framework.",
				licenses: ["MIT"],
				homepage_uri: "https://rubyonrails.org",
				source_code_uri: "https://github.com/rails/rails",
				documentation_uri: "https://api.rubyonrails.org",
				authors: "David Heinemeier Hansson",
				downloads: 380000000,
				version_downloads: 2500000,
				dependencies: {
					runtime: [
						{ name: "actionpack", requirements: "= 7.1.2" },
						{ name: "activerecord", requirements: "= 7.1.2" },
					],
					development: [{ name: "rake", requirements: ">= 13.0" }],
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://rubygems.org/api/v1/gems/rails.json");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://rubygems.org/gems/rails", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# rails");
			expect(result.content).toContain("Sentinel Ruby on Rails is a full-stack web framework.");
			expect(result.content).toContain("**Version:** 7.1.2 · **License:** MIT");
			expect(result.content).toContain("**Total Downloads:** 380M · **Version Downloads:** 2.5M");
			expect(result.content).toContain("**Homepage:** https://rubyonrails.org");
			expect(result.content).toContain("**Source Code:** https://github.com/rails/rails");
			expect(result.content).toContain("**Documentation:** https://api.rubyonrails.org");
			expect(result.content).toContain("**Authors:** David Heinemeier Hansson");
			expect(result.content).toContain("## Runtime Dependencies\n\n- actionpack = 7.1.2\n- activerecord = 7.1.2");
			expect(result.content).toContain("## Development Dependencies\n\n- rake >= 13.0");
		});
	});

	// 25. Snapcraft
	describe("snapcraft package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "snapcraft")!;
		const handler = createPackageRegistryHandler(decl, "handleSnapcraft");

		it("renders snapcraft snap with confinement, base, publisher username, and channels with architectures", async () => {
			const fixture = {
				name: "vlc",
				title: "Sentinel VLC",
				summary: "Sentinel The ultimate media player",
				description: "Sentinel VLC is a free and open source cross-platform multimedia player.",
				publisher: {
					"display-name": "VideoLAN",
					username: "videolan",
				},
				confinement: "classic",
				base: "core18",
				downloads: 15000000,
				"channel-map": [
					{
						channel: { track: "latest", risk: "stable", architecture: "amd64" },
						version: "3.0.20",
					},
					{
						channel: { track: "latest", risk: "stable", architecture: "arm64" },
						version: "3.0.20",
					},
					{
						channel: { track: "latest", risk: "edge", architecture: "amd64" },
						version: "4.0.0-dev",
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://api.snapcraft.io/v2/snaps/info/vlc");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://snapcraft.io/vlc", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel VLC");
			expect(result.content).toContain("Sentinel The ultimate media player");
			expect(result.content).toContain("**Version:** 3.0.20 · **Confinement:** classic · **Base:** core18");
			expect(result.content).toContain("**Publisher:** VideoLAN (@videolan)");
			expect(result.content).toContain("**Downloads:** 15M");
			expect(result.content).toContain(
				"## Channels\n\n- latest/edge: 4.0.0-dev (amd64)\n- latest/stable: 3.0.20 (amd64, arm64)",
			);
			expect(result.content).toContain(
				"## Description\n\nSentinel VLC is a free and open source cross-platform multimedia player.",
			);
		});
	});

	// 26. Terraform Registry
	describe("terraform package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "terraform")!;
		const handler = createPackageRegistryHandler(decl, "handleTerraform");

		it("renders terraform module with HCL usage, inputs table, outputs, and submodules", async () => {
			const moduleFixture = {
				id: "terraform-aws-modules/vpc/aws",
				namespace: "terraform-aws-modules",
				name: "vpc",
				provider: "aws",
				version: "5.4.0",
				description: "Sentinel Terraform module to create AWS VPC resources.",
				downloads: 48000000,
				verified: true,
				published_at: "2023-11-15T00:00:00Z",
				source: "https://github.com/terraform-aws-modules/terraform-aws-vpc",
				root: {
					inputs: [
						{ name: "name", type: "string", required: false, default: '""', description: "Name of the VPC" },
						{ name: "cidr", type: "string", required: true, description: "CIDR block for VPC" },
					],
					outputs: [
						{ name: "vpc_id", description: "The ID of the VPC" },
						{ name: "private_subnets", description: "List of IDs of private subnets" },
					],
					dependencies: [{ name: "aws", source: "hashicorp/aws", version: ">= 4.0" }],
					resources: [{ type: "aws_vpc", name: "this" }],
				},
				submodules: [{ name: "vpc-endpoints", path: "modules/vpc-endpoints" }],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://registry.terraform.io/v1/modules/terraform-aws-modules/vpc/aws");
				return {
					content: JSON.stringify(moduleFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# terraform-aws-modules/vpc/aws");
			expect(result.content).toContain("Sentinel Terraform module to create AWS VPC resources.");
			expect(result.content).toContain("**Version:** 5.4.0 ✓ Verified");
			expect(result.content).toContain("**Downloads:** 48M");
			expect(result.content).toContain("**Source:** https://github.com/terraform-aws-modules/terraform-aws-vpc");
			expect(result.content).toContain(
				'```hcl\nmodule "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.4.0"\n}\n```',
			);
			expect(result.content).toContain("## Inputs (2)");
			expect(result.content).toContain("| name | `string` | No | Name of the VPC |");
			expect(result.content).toContain("| cidr | `string` | Yes | CIDR block for VPC |");
			expect(result.content).toContain(
				"## Outputs (2)\n\n- **vpc_id**: The ID of the VPC\n- **private_subnets**: List of IDs of private subnets",
			);
			expect(result.content).toContain("## Dependencies (1)\n\n- **aws**: hashicorp/aws (>= 4.0)");
			expect(result.content).toContain("## Resources (1)\n\n- `aws_vpc` (this)");
			expect(result.content).toContain("## Submodules (1)\n\n- **vpc-endpoints**: `modules/vpc-endpoints`");
		});

		it("renders terraform provider with HCL required_providers usage and documentation categories", async () => {
			const providerFixture = {
				id: "hashicorp/aws",
				namespace: "hashicorp",
				name: "aws",
				version: "5.31.0",
				description: "Sentinel Terraform provider for Amazon Web Services.",
				tier: "official",
				downloads: 950000000,
				published_at: "2023-12-14T00:00:00Z",
				source: "https://github.com/hashicorp/terraform-provider-aws",
				docs: [
					{ id: "doc-1", title: "Overview", path: "overview", slug: "overview", category: "guides" },
					{ id: "doc-2", title: "aws_s3_bucket", path: "r/s3_bucket", slug: "s3_bucket", category: "resources" },
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://registry.terraform.io/v1/providers/hashicorp/aws");
				return {
					content: JSON.stringify(providerFixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://registry.terraform.io/providers/hashicorp/aws/latest",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# hashicorp/aws");
			expect(result.content).toContain("Sentinel Terraform provider for Amazon Web Services.");
			expect(result.content).toContain("**Version:** 5.31.0");
			expect(result.content).toContain("**Tier:** official");
			expect(result.content).toContain("**Downloads:** 950M");
			expect(result.content).toContain(
				'```hcl\nterraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.31.0"\n    }\n  }\n}\n\nprovider "aws" {\n  # Configuration options\n}\n```',
			);
			expect(result.content).toContain(
				"## Documentation\n\n### Guides (1)\n\n- [Overview](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/guides/overview)",
			);
			expect(result.content).toContain(
				"### Resources (1)\n\n- [aws_s3_bucket](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket)",
			);
		});
	});

	// 27. VS Code Marketplace
	describe("vscode-marketplace package registry scraper", () => {
		const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "vscode-marketplace")!;
		const handler = createPackageRegistryHandler(decl, "handleVscodeMarketplace");

		it("renders vscode extension with installs, rating, publisher, and categories", async () => {
			const fixture = {
				results: [
					{
						extensions: [
							{
								extensionName: "python",
								displayName: "Sentinel Python",
								shortDescription: "Sentinel IntelliSense, linting, debugging for Python.",
								publisher: { publisherName: "ms-python", displayName: "Microsoft" },
								versions: [
									{
										version: "2024.0.1",
										properties: [
											{
												key: "Microsoft.VisualStudio.Services.Links.Source",
												value: "https://github.com/microsoft/vscode-python",
											},
										],
									},
								],
								statistics: [
									{ statisticName: "install", value: 105000000 },
									{ statisticName: "averagerating", value: 4.35 },
									{ statisticName: "ratingcount", value: 850 },
								],
								categories: ["Programming Languages", "Linters"],
								tags: ["python", "django"],
							},
						],
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				expect(url).toBe("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery");
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://marketplace.visualstudio.com/items?itemName=ms-python.python",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Sentinel Python");
			expect(result.content).toContain("Sentinel IntelliSense, linting, debugging for Python.");
			expect(result.content).toContain("**Identifier:** ms-python.python");
			expect(result.content).toContain("**Publisher:** Microsoft (ms-python)");
			expect(result.content).toContain("**Version:** 2024.0.1");
			expect(result.content).toContain("**Installs:** 105M");
			expect(result.content).toContain("**Rating:** 4.35 (850 ratings)");
			expect(result.content).toContain("**Categories:** Programming Languages, Linters");
			expect(result.content).toContain("**Tags:** python, django");
			expect(result.content).toContain("**Repository:** https://github.com/microsoft/vscode-python");
		});
	});

	describe("package registry edge cases for missing, zero, and markdown-sensitive values", () => {
		it("handles artifacthub with missing maintainers, empty badges, zero stars, and no readme", async () => {
			const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "artifacthub")!;
			const handler = createPackageRegistryHandler(decl, "handleArtifactHubEdge");
			const fixture = {
				package_id: "pkg-empty",
				name: "minimal-pkg",
				normalized_name: "minimal-pkg",
				version: "1.0.0",
				repository: {
					name: "repo-name",
					url: "https://example.com/repo",
				},
				ts: 1690000000,
				created_at: 1600000000,
				stars: 0,
				official: false,
				signed: false,
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => ({
				content: JSON.stringify(fixture),
				contentType: "application/json",
				finalUrl: url,
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://artifacthub.io/packages/helm/repo-name/minimal-pkg",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# minimal-pkg\n\n**Type:** Helm Chart · **Version:** 1.0.0\n\n");
			expect(result.content).not.toContain("stars");
			expect(result.content).not.toContain("## README");
			expect(result.content).not.toContain("## Installation");
		});

		it("handles AUR with orphaned package, out-of-date flag, and empty dependencies", async () => {
			const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "aur")!;
			const handler = createPackageRegistryHandler(decl, "handleAurEdge");
			const fixture = {
				version: 5,
				type: "info",
				resultcount: 1,
				results: [
					{
						Name: "orphan-pkg",
						PackageBase: "orphan-pkg",
						Version: "0.1.0",
						NumVotes: 0,
						Popularity: 0.0,
						LastModified: 1600000000,
						FirstSubmitted: 1500000000,
						OutOfDate: 1650000000,
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => ({
				content: JSON.stringify(fixture),
				contentType: "application/json",
				finalUrl: url,
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://aur.archlinux.org/packages/orphan-pkg",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# orphan-pkg\n\n");
			expect(result.content).toContain("**Version:** 0.1.0 (flagged out-of-date: ");
			expect(result.content).toContain("**Maintainer:** Orphaned\n");
			expect(result.content).toContain("**Votes:** 0 · **Popularity:** 0.00\n");
			expect(result.content).not.toContain("## Dependencies");
		});

		it("handles crates.io with 0 downloads, missing docs.rs readme, and markdown-sensitive package name", async () => {
			const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "crates-io")!;
			const handler = createPackageRegistryHandler(decl, "handleCratesIoEdge");
			const fixture = {
				crate: {
					name: "foo_bar_baz",
					description: "A crate with _special_ *characters* & symbols",
					downloads: 0,
					recent_downloads: 0,
					max_version: "0.0.1",
					repository: null,
					homepage: null,
					documentation: null,
					categories: [],
					keywords: [],
					created_at: "2024-01-01T00:00:00Z",
					updated_at: "2024-01-01T00:00:00Z",
				},
				versions: [
					{
						num: "0.0.1",
						downloads: 0,
						created_at: "2024-01-01T00:00:00Z",
						license: "MIT",
						rust_version: null,
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("docs.rs")) {
					return { content: "", contentType: "text/plain", finalUrl: url, ok: false, status: 404 };
				}
				return {
					content: JSON.stringify(fixture),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler("https://crates.io/crates/foo_bar_baz", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# foo_bar_baz\n\nA crate with _special_ *characters* & symbols\n\n");
			expect(result.content).toContain("**Latest:** 0.0.1 · **License:** MIT\n");
			expect(result.content).toContain("**Downloads:** 0 total · 0 recent\n\n");
			expect(result.content).not.toContain("## README");
		});

		it("handles Repology with elided repositories above limit and escaping in table cells", async () => {
			const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "repology")!;
			const handler = createPackageRegistryHandler(decl, "handleRepologyEdge");
			const packages = Array.from({ length: 20 }, (_, i) => ({
				repo: `repo_${i}|special`,
				version: `1.0.${i}|build`,
				status: i === 0 ? "newest" : "outdated",
				summary: "Package with | pipes in metadata",
			}));

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => ({
				content: JSON.stringify(packages),
				contentType: "application/json",
				finalUrl: url,
				ok: true,
				status: 200,
			}));

			const result = (await handler("https://repology.org/project/test-pkg", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("[…5 repositories elided…]");
			expect(result.content).toContain("\\|build`");
		});

		it("handles Terraform module with inputs and outputs exceeding limit boundaries", async () => {
			const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "terraform")!;
			const handler = createPackageRegistryHandler(decl, "handleTerraformEdge");
			const fixture = {
				id: "mod-1",
				namespace: "ns",
				name: "vpc",
				provider: "aws",
				version: "1.0.0",
				downloads: 500,
				root: {
					inputs: Array.from({ length: 35 }, (_, i) => ({
						name: `input_${i}`,
						type: "string",
						description: `Input description ${i}`,
						required: i % 2 === 0,
					})),
					outputs: Array.from({ length: 25 }, (_, i) => ({
						name: `output_${i}`,
						description: `Output description ${i}`,
					})),
					dependencies: Array.from({ length: 20 }, (_, i) => ({
						name: `dep_${i}`,
						source: `terraform-aws-modules/dep_${i}`,
						version: "~> 1.0",
					})),
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => ({
				content: JSON.stringify(fixture),
				contentType: "application/json",
				finalUrl: url,
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://registry.terraform.io/modules/ns/vpc/aws/latest",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("## Inputs (35)");
			expect(result.content).toContain("[…5 inputs elided…]");
			expect(result.content).toContain("## Outputs (25)");
			expect(result.content).toContain("[…5 outputs elided…]");
			expect(result.content).toContain("## Dependencies (20)");
			expect(result.content).toContain("[…5 dependencies elided…]");
		});

		it.each([
			{ items: undefined },
			{ items: null },
			{ items: [] },
			{ items: ["alpha|beta"] },
			{ items: ["alpha|beta", "_gamma_"] },
		])("preserves absent, empty, counted and uncounted AUR lists: %j", async ({ items }) => {
			const declaration = PACKAGE_REGISTRY_DECLARATIONS.find(site => site.site === "aur")!;
			const fields = [
				["Depends", "Dependencies", true],
				["MakeDepends", "Make Dependencies", true],
				["OptDepends", "Optional Dependencies", false],
				["CheckDepends", "Check Dependencies", false],
				["Provides", "Provides", false],
				["Conflicts", "Conflicts", false],
				["Replaces", "Replaces", false],
			] as const;
			const fixture = {
				resultcount: 1,
				results: [
					{
						Name: "example-package",
						Description: "  _example_  \n",
						PackageBase: "example-package",
						Version: "1",
						NumVotes: 0,
						Popularity: 0,
						LastModified: 1600000000,
						FirstSubmitted: 1500000000,
						...Object.fromEntries(fields.map(([field]) => [field, items])),
					},
				],
			};
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async url => ({
				content: JSON.stringify(fixture),
				contentType: "application/json",
				finalUrl: url,
				ok: true,
				status: 200,
			}));
			const result = await createPackageRegistryHandler(declaration)(
				"https://aur.archlinux.org/packages/example-package",
				10,
			);
			if (!result || !("content" in result)) throw new Error("Expected a rendered AUR package");
			expect(result.content).toContain("# example-package\n\n  _example_  \n\n");
			for (const [, title, counted] of fields) {
				if (!items?.length) {
					expect(result.content).not.toContain(`## ${title}`);
				} else {
					const count = counted ? ` (${items.length})` : "";
					expect(result.content).toContain(
						`\n## ${title}${count}\n\n${items.map(item => `- ${item}\n`).join("")}`,
					);
				}
			}
		});

		it("omits empty Homebrew descriptions, caveats and dependency sections", async () => {
			const declaration = PACKAGE_REGISTRY_DECLARATIONS.find(site => site.site === "brew")!;
			const fixture = { name: "example-package", versions: { stable: "1" }, desc: "", dependencies: [] };
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async url => ({
				content: JSON.stringify(fixture),
				contentType: "application/json",
				finalUrl: url,
				ok: true,
				status: 200,
			}));
			const result = await createPackageRegistryHandler(declaration)(
				"https://formulae.brew.sh/formula/example-package",
				10,
			);
			if (!result || !("content" in result)) throw new Error("Expected a rendered Homebrew package");
			expect(result.content).toContain("# example-package\n\n**Version:** 1\n");
			expect(result.content).not.toContain("## Caveats");
			expect(result.content).not.toContain("## Dependencies");
			expect(result.content).not.toContain("undefined");
		});

		it.each([0, 1, 5, 6])("silently limits ArtifactHub versions at the five-row boundary: %i", async count => {
			const declaration = PACKAGE_REGISTRY_DECLARATIONS.find(site => site.site === "artifacthub")!;
			const fixture = {
				name: "example-package",
				version: "1",
				repository: { name: "example-repository", url: "" },
				available_versions: Array.from({ length: count }, (_, index) => ({ version: `v${index}`, ts: 1600000000 })),
			};
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async url => ({
				content: JSON.stringify(fixture),
				contentType: "application/json",
				finalUrl: url,
				ok: true,
				status: 200,
			}));
			const result = await createPackageRegistryHandler(declaration)(
				"https://artifacthub.io/packages/helm/example-repository/example-package",
				10,
			);
			if (!result || !("content" in result)) throw new Error("Expected a rendered ArtifactHub package");
			if (count === 0) expect(result.content).not.toContain("## Recent Versions");
			else expect(result.content).toContain("\n## Recent Versions\n\n");
			for (let index = 0; index < count; index++) {
				if (index < 5) expect(result.content).toContain(`- **v${index}**`);
				else expect(result.content).not.toContain(`**v${index}**`);
			}
			expect(result.content).not.toContain("elided");
		});

		it("preserves Clojars null return on falsy or malformed payload versus ScraperDegrade on fetch failure", async () => {
			const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "clojars")!;
			const handler = createPackageRegistryHandler(decl);

			// 1. Fetch failure -> ScraperDegrade
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockResolvedValueOnce({
				content: "Internal Server Error",
				contentType: "text/plain",
				finalUrl: "https://clojars.org/api/artifacts/clj-http",
				ok: false,
				status: 500,
			});
			const failResult = await handler("https://clojars.org/clj-http", 10);
			expect(failResult).toMatchObject({ scraperDegrade: true });

			// 2. Malformed JSON -> null
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockResolvedValueOnce({
				content: "not json",
				contentType: "text/plain",
				finalUrl: "https://clojars.org/api/artifacts/clj-http",
				ok: true,
				status: 200,
			});
			const badJsonResult = await handler("https://clojars.org/clj-http", 10);
			expect(badJsonResult).toBeNull();

			// 3. Non-record payload (e.g. primitive number) -> null
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockResolvedValueOnce({
				content: "42",
				contentType: "application/json",
				finalUrl: "https://clojars.org/api/artifacts/clj-http",
				ok: true,
				status: 200,
			});
			const nonRecordResult = await handler("https://clojars.org/clj-http", 10);
			expect(nonRecordResult).toBeNull();
		});

		it("preserves exact request headers for all package registry declarations", async () => {
			const recordedHeaders = new Map<string, Record<string, string> | undefined>();

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url, options) => {
				for (const decl of PACKAGE_REGISTRY_DECLARATIONS) {
					if (decl.hosts.some(h => url.includes(h))) {
						recordedHeaders.set(decl.site, options?.headers as Record<string, string> | undefined);
					}
				}
				return {
					content: "{}",
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			for (const decl of PACKAGE_REGISTRY_DECLARATIONS) {
				const handler = createPackageRegistryHandler(decl);
				try {
					await handler(decl.canonicalUrls[0], 10);
				} catch {
					// Expected to possibly fail on empty dummy payload {}
				}
			}

			// Declarations that originally did NOT send Accept: application/json
			expect(recordedHeaders.get("aur")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("brew")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("crates-io")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("crates-io")?.["User-Agent"]).toContain("veyyon-web-fetch");
			expect(recordedHeaders.get("hex")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("npm")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("nuget")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("open-vsx")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("packagist")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("pub-dev")?.Accept).toBeUndefined();
			expect(recordedHeaders.get("pypi")?.Accept).toBeUndefined();

			// Declarations that DO send Accept: application/json
			expect(recordedHeaders.get("artifacthub")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("clojars")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("dockerhub")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("fdroid")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("hackage")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("maven")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("repology")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("repology")?.["User-Agent"]).toContain("Mozilla/5.0");
			expect(recordedHeaders.get("rubygems")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("snapcraft")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("snapcraft")?.["Snap-Device-Series"]).toBe("16");
			expect(recordedHeaders.get("terraform")?.Accept).toBe("application/json");
			expect(recordedHeaders.get("vscode-marketplace")?.Accept).toContain("application/json");
		});

		it("handles Flathub screenshot non-finite, sparse, and undefined dimensions safely", async () => {
			const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === "flathub")!;
			const handler = createPackageRegistryHandler(decl);

			const fixture = {
				id: "org.test.App",
				name: "Test App",
				summary: "Test Summary",
				screenshots: [
					{
						sizes: [
							{ width: Infinity as unknown as string, height: 100, src: "https://example.com/bad-infinity.png" },
							{ width: NaN as unknown as string, height: 100, src: "https://example.com/bad-nan.png" },
							{ width: "800", height: "600", src: "https://example.com/good-large.png" },
							{ width: "400", height: "300", src: "https://example.com/good-small.png" },
						],
					},
					{
						sizes: [],
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockResolvedValueOnce({
				content: JSON.stringify(fixture),
				contentType: "application/json",
				finalUrl: "https://flathub.org/apps/org.test.App",
				ok: true,
				status: 200,
			});

			const result = (await handler("https://flathub.org/apps/org.test.App", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("https://example.com/good-large.png");
			expect(result.content).not.toContain("https://example.com/bad-infinity.png");
		});
	});
	describe("package registry generic dispatch invariants: host matching, degradation, cancellation, and names", () => {
		it("preserves handler names when handlerName is passed", () => {
			for (const decl of PACKAGE_REGISTRY_DECLARATIONS) {
				const handler = createPackageRegistryHandler(decl, `handle_${decl.site}`);
				expect(handler.name).toBe(`handle_${decl.site}`);
			}
		});

		it("rejects non-matching and foreign host URLs synchronously", async () => {
			for (const decl of PACKAGE_REGISTRY_DECLARATIONS) {
				const handler = createPackageRegistryHandler(decl);
				expect(await handler("https://unrelated-domain.org/package/123", 10)).toBeNull();
				expect(await handler("not-a-valid-url", 10)).toBeNull();
			}
		});

		it("decodes URL components in pathPattern matches", async () => {
			let recordedMatch: { name: string; version?: string } | undefined;
			const sampleDecl = {
				site: "test-registry",
				hosts: ["test-registry.org"],
				canonicalUrls: ["https://test-registry.org/packages/sample"],
				pathPattern: /^\/packages\/([^/]+)(?:\/([^/]+))?/,
				customFetch: async (match: { name: string; version?: string }) => {
					recordedMatch = match;
					return "ok";
				},
			};
			const handler = createPackageRegistryHandler(sampleDecl);
			const res = await handler("https://test-registry.org/packages/foo%2Bbar/1.0%2Bbeta%201", 10);
			expect(res).not.toBeNull();
			expect(recordedMatch?.name).toBe("foo+bar");
			expect(recordedMatch?.version).toBe("1.0+beta 1");

			for (const site of ["aur", "crates-io", "nuget"]) {
				const decl = PACKAGE_REGISTRY_DECLARATIONS.find(d => d.site === site)!;
				let declMatch: { name: string; version?: string } | undefined;
				const h = createPackageRegistryHandler({
					...decl,
					customFetch: async match => {
						declMatch = match;
						return "ok";
					},
				});
				if (site === "crates-io") {
					await h("https://crates.io/crates/foo%2Bbar", 10);
					expect(declMatch?.name).toBe("foo+bar");
				} else if (site === "aur") {
					await h("https://aur.archlinux.org/packages/foo%2Bbar", 10);
					expect(declMatch?.name).toBe("foo+bar");
				} else if (site === "nuget") {
					await h("https://www.nuget.org/packages/foo%2Bbar/2.0%2Brev", 10);
					expect(declMatch?.name).toBe("foo+bar");
					expect(declMatch?.version).toBe("2.0+rev");
				}
			}
		});

		it("propagates cancellation without swallowing into ScraperDegrade", async () => {
			for (const decl of PACKAGE_REGISTRY_DECLARATIONS) {
				const cancellingDecl = {
					...decl,
					customFetch: async () => {
						throw new DOMException("The operation was aborted", "AbortError");
					},
				};
				const handler = createPackageRegistryHandler(cancellingDecl);
				const sampleUrl = decl.canonicalUrls[0];
				await expect(handler(sampleUrl, 10)).rejects.toMatchObject({ name: "AbortError" });
			}
		});

		it("returns scraperDegrade on general thrown errors", async () => {
			for (const decl of PACKAGE_REGISTRY_DECLARATIONS) {
				const failingDecl = {
					...decl,
					customFetch: async () => {
						throw new Error("network explosion");
					},
				};
				const handler = createPackageRegistryHandler(failingDecl);
				const sampleUrl = decl.canonicalUrls[0];
				const res = await handler(sampleUrl, 10);
				expect(res).toMatchObject({ scraperDegrade: true });
			}
		});
	});
});
