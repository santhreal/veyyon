import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { BUSINESS_DECLARATIONS } from "../../src/scrapers/declarations/business";
import { MEDIA_DECLARATIONS } from "../../src/scrapers/declarations/media";
import { SECURITY_ADVISORY_DECLARATIONS } from "../../src/scrapers/declarations/security-advisories";
import { createBusinessHandler } from "../../src/scrapers/engine/business";
import { createMediaHandler } from "../../src/scrapers/engine/media";
import { createSecurityAdvisoryHandler } from "../../src/scrapers/engine/security-advisory";
import * as scraperTypes from "../../src/scrapers/types";

describe("field fidelity across media, business, and security advisory site declarations", () => {
	let loadPageSpy: { mockRestore: () => void } | null = null;

	afterEach(() => {
		if (loadPageSpy) {
			loadPageSpy.mockRestore();
			loadPageSpy = null;
		}
	});

	it("derives all 12 sites from the three exported declaration arrays at run time", () => {
		const mediaSites = MEDIA_DECLARATIONS.map(d => d.site);
		const businessSites = BUSINESS_DECLARATIONS.map(d => d.site);
		const securitySites = SECURITY_ADVISORY_DECLARATIONS.map(d => d.site);

		expect(mediaSites).toEqual(["discogs", "musicbrainz", "rawg", "spotify", "vimeo"]);
		expect(businessSites).toEqual(["coingecko", "opencorporates", "sec-edgar", "searchcode"]);
		expect(securitySites).toEqual(["cisa-kev", "nvd", "osv"]);
	});

	describe("discogs media declaration", () => {
		const discogsDecl = MEDIA_DECLARATIONS.find(d => d.site === "discogs")!;
		const handler = createMediaHandler(discogsDecl, "handleDiscogs");

		it("renders release with artist name variations, join strings, formats, labels, track artists, credits, and notes", async () => {
			const releaseJson = {
				id: 249504,
				title: "Discovery",
				artists: [
					{ name: "Daft Punk", anv: "Daft Punk", join: "feat." },
					{ name: "Romanthony", anv: "Romanthony" },
				],
				year: 2001,
				country: "France",
				genres: ["Electronic"],
				styles: ["House", "Disco"],
				labels: [{ name: "Virgin", catno: "CDV 2940" }],
				formats: [{ name: "CD", qty: "1", descriptions: ["Album", "Enhanced"] }],
				master_id: 26647,
				tracklist: [
					{
						position: "1",
						title: "One More Time",
						duration: "5:20",
						artists: [{ name: "Romanthony" }],
					},
					{
						position: "2",
						title: "Aerodynamic",
						duration: "3:27",
					},
				],
				extraartists: [
					{ name: "Guy-Manuel de Homem-Christo", role: "Producer" },
					{ name: "Thomas Bangalter", role: "Producer" },
				],
				notes: "Recorded at Gang Studios, Paris.",
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async url => {
				expect(url).toBe("https://api.discogs.com/releases/249504");
				return {
					content: JSON.stringify(releaseJson),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://www.discogs.com/release/249504-Daft-Punk-Discovery",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.method).toBe("discogs");
			expect(result.content).toContain("# Daft Punk feat. Romanthony - Discovery");
			expect(result.content).toContain("**Year**: 2001");
			expect(result.content).toContain("**Country**: France");
			expect(result.content).toContain("**Format**: CD Album, Enhanced");
			expect(result.content).toContain("**Label**: Virgin (CDV 2940)");
			expect(result.content).toContain("**Genre**: Electronic");
			expect(result.content).toContain("**Style**: House, Disco");
			expect(result.content).toContain("**Master Release**: [26647](https://www.discogs.com/master/26647)");
			expect(result.content).toContain("## Tracklist");
			expect(result.content).toContain("1. One More Time (5:20) - Romanthony");
			expect(result.content).toContain("2. Aerodynamic (3:27)");
			expect(result.content).toContain("## Credits");
			expect(result.content).toContain("- **Producer**: Guy-Manuel de Homem-Christo, Thomas Bangalter");
			expect(result.content).toContain("## Notes\n\nRecorded at Gang Studios, Paris.");
		});

		it("renders master release with market info, main release link, and tracks", async () => {
			const masterJson = {
				id: 26647,
				title: "Discovery",
				artists: [{ name: "Daft Punk" }],
				year: 2001,
				genres: ["Electronic"],
				styles: ["House"],
				main_release: 249504,
				num_for_sale: 450,
				lowest_price: 15.5,
				tracklist: [{ position: "A1", title: "One More Time", duration: "5:20" }],
				notes: "Master album notes.",
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async url => {
				expect(url).toBe("https://api.discogs.com/masters/26647");
				return {
					content: JSON.stringify(masterJson),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://www.discogs.com/master/26647-Daft-Punk-Discovery",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Daft Punk - Discovery");
			expect(result.content).toContain("*Master Release*");
			expect(result.content).toContain("**Main Release**: [249504](https://www.discogs.com/release/249504)");
			expect(result.content).toContain("**For Sale**: 450 copies");
			expect(result.content).toContain("**Lowest Price**: $15.50");
			expect(result.content).toContain("A1. One More Time (5:20)");
		});
	});

	describe("musicbrainz media declaration", () => {
		const mbDecl = MEDIA_DECLARATIONS.find(d => d.site === "musicbrainz")!;
		const handler = createMediaHandler(mbDecl, "handleMusicBrainz");

		it("renders artist with life-span, country, and type", async () => {
			const artistJson = {
				id: "c8da2e40-3c48-4244-bc96-0f7236599691",
				name: "Daft Punk",
				type: "Group",
				country: "FR",
				"life-span": { begin: "1993", end: "2021-02-22", ended: true },
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(artistJson),
				contentType: "application/json",
				finalUrl: "https://musicbrainz.org/ws/2/artist/c8da2e40-3c48-4244-bc96-0f7236599691?fmt=json&inc=url-rels",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://musicbrainz.org/artist/c8da2e40-3c48-4244-bc96-0f7236599691",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Daft Punk");
			expect(result.content).toContain("**Type**: Group");
			expect(result.content).toContain("**Country**: FR");
			expect(result.content).toContain("**Life Span**: 1993 - 2021-02-22");
		});

		it("renders release with multi-medium tracks and elides beyond 50 tracks", async () => {
			const tracks = Array.from({ length: 55 }, (_, i) => ({
				number: `${i + 1}`,
				title: `Track ${i + 1}`,
				length: 180000 + i * 1000,
			}));

			const releaseJson = {
				id: "07545b14-fb12-4217-b9e7-57352eb5b974",
				title: "Discovery Deluxe",
				media: [
					{
						position: 1,
						format: "CD",
						tracks,
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(releaseJson),
				contentType: "application/json",
				finalUrl:
					"https://musicbrainz.org/ws/2/release/07545b14-fb12-4217-b9e7-57352eb5b974?fmt=json&inc=recordings",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://musicbrainz.org/release/07545b14-fb12-4217-b9e7-57352eb5b974",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Discovery Deluxe");
			expect(result.content).toContain("**Tracks**: 55");
			expect(result.content).toContain("1. Track 1 (3:00)");
			expect(result.content).toContain("50. Track 50 (3:49)");
			expect(result.content).toContain("_Showing first 50 of 55 tracks._");
			expect(result.content).not.toContain("51. Track 51");
		});

		it("renders recording with artist credit and length", async () => {
			const recordingJson = {
				id: "fcb7bc6b-8de9-4824-9549-36c1340156a0",
				title: "One More Time",
				length: 320000,
				"artist-credit": [{ name: "Daft Punk" }],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(recordingJson),
				contentType: "application/json",
				finalUrl: "https://musicbrainz.org/ws/2/recording/fcb7bc6b-8de9-4824-9549-36c1340156a0?fmt=json",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://musicbrainz.org/recording/fcb7bc6b-8de9-4824-9549-36c1340156a0",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# One More Time");
			expect(result.content).toContain("**Artists**: Daft Punk");
			expect(result.content).toContain("**Length**: 5:20");
		});
	});

	describe("rawg media declaration", () => {
		const rawgDecl = MEDIA_DECLARATIONS.find(d => d.site === "rawg")!;
		const handler = createMediaHandler(rawgDecl, "handleRawg");

		it("renders game with released date, 2-decimal rating, deduped platforms, genres, RAWG link, and description", async () => {
			const gameJson = {
				name: "The Witcher 3: Wild Hunt",
				released: "2015-05-18",
				rating: 4.6666,
				platforms: [
					{ platform: { name: "PC" } },
					{ platform: { name: "PlayStation 4" } },
					{ platform: { name: "PC" } },
				],
				genres: [{ name: "Action" }, { name: "RPG" }, { name: "Action" }],
				description_raw: "An open world RPG following Geralt of Rivia.",
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(gameJson),
				contentType: "application/json",
				finalUrl: "https://api.rawg.io/api/games/the-witcher-3-wild-hunt",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://rawg.io/games/the-witcher-3-wild-hunt",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# The Witcher 3: Wild Hunt");
			expect(result.content).toContain("**Released:** 2015-05-18");
			expect(result.content).toContain("**Rating:** 4.67 / 5");
			expect(result.content).toContain("**Platforms:** PC, PlayStation 4");
			expect(result.content).toContain("**Genres:** Action, RPG");
			expect(result.content).toContain("**RAWG:** https://rawg.io/games/the-witcher-3-wild-hunt");
			expect(result.content).toContain("## Description\n\nAn open world RPG following Geralt of Rivia.");
		});

		it("returns null when RAWG response reports API key required", async () => {
			const apiKeyReqJson = { detail: "API key is required" };
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(apiKeyReqJson),
				contentType: "application/json",
				finalUrl: "https://api.rawg.io/api/games/secret-game",
				ok: true,
				status: 200,
			}));

			const result = await handler("https://rawg.io/games/secret-game", 10);
			expect(result).toBeNull();
		});
	});

	describe("spotify media declaration", () => {
		const spotifyDecl = MEDIA_DECLARATIONS.find(d => d.site === "spotify")!;
		const handler = createMediaHandler(spotifyDecl, "handleSpotify");

		it("renders track with oEmbed title and OpenGraph metadata including duration and artist", async () => {
			const oembedJson = {
				title: "Bohemian Rhapsody",
				thumbnail_url: "https://i.scdn.co/image/ab67616d0000b273e319baafd16e84f0408af2a0",
			};
			const ogHtml = `
				<html>
					<head>
						<meta property="og:title" content="Bohemian Rhapsody">
						<meta property="og:description" content="Queen · Song · 1975">
						<meta property="music:musician" content="Queen">
						<meta property="music:album" content="A Night at the Opera">
						<meta property="music:duration" content="354">
					</head>
				</html>
			`;

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/oembed")) {
					return {
						content: JSON.stringify(oembedJson),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return {
					content: ogHtml,
					contentType: "text/html",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			});

			const result = (await handler(
				"https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Bohemian Rhapsody");
			expect(result.content).toContain("**Type**: track");
			expect(result.content).toContain("**Description**: Queen · Song · 1975");
			expect(result.content).toContain("**Artist**: Queen");
			expect(result.content).toContain("**Album**: A Night at the Opera");
			expect(result.content).toContain("**Duration**: 5:54");
			expect(result.content).toContain(
				"**Thumbnail**: https://i.scdn.co/image/ab67616d0000b273e319baafd16e84f0408af2a0",
			);
		});

		it("renders album with auth disclaimer", async () => {
			const oembedJson = { title: "A Night at the Opera" };
			const ogHtml = `
				<html>
					<head>
						<meta property="og:title" content="A Night at the Opera">
						<meta property="music:release_date" content="1975-11-21">
					</head>
				</html>
			`;

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/oembed")) {
					return {
						content: JSON.stringify(oembedJson),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: ogHtml, contentType: "text/html", finalUrl: url, ok: true, status: 200 };
			});

			const result = (await handler(
				"https://open.spotify.com/album/4m28ee0Q95grY5SODvQU29",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("**Release Date**: 1975-11-21");
			expect(result.content).toContain(
				"**Note**: Track listing and detailed album information require authentication.",
			);
		});
	});

	describe("vimeo media declaration", () => {
		const vimeoDecl = MEDIA_DECLARATIONS.find(d => d.site === "vimeo")!;
		const handler = createMediaHandler(vimeoDecl, "handleVimeo");

		it("renders video metadata from oEmbed and progressive qualities from config", async () => {
			const oembedJson = {
				title: "The Mountain",
				author_name: "TSO Photography",
				author_url: "https://vimeo.com/terjes",
				duration: 184,
				upload_date: "2011-04-29 02:40:08",
				thumbnail_url: "https://i.vimeocdn.com/video/149847259.jpg",
				description: "A time lapse of Mount Teide.",
			};
			const configJson = {
				request: {
					files: {
						progressive: [
							{ quality: "1080p", width: 1920, height: 1080, fps: 24 },
							{ quality: "720p", width: 1280, height: 720, fps: 24 },
						],
					},
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("oembed.json")) {
					return {
						content: JSON.stringify(oembedJson),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				if (url.includes("/config")) {
					return {
						content: JSON.stringify(configJson),
						contentType: "application/json",
						finalUrl: url,
						ok: true,
						status: 200,
					};
				}
				return { content: "", contentType: "text/plain", finalUrl: url, ok: false, status: 404 };
			});

			const result = (await handler("https://vimeo.com/76979871", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# The Mountain");
			expect(result.content).toContain("**Author:** [TSO Photography](https://vimeo.com/terjes)");
			expect(result.content).toContain("**Duration:** 3:04");
			expect(result.content).toContain("**Uploaded:** 2011-04-29 02:40:08");
			expect(result.content).toContain("**Video ID:** 76979871");
			expect(result.content).toContain("## Description\n\nA time lapse of Mount Teide.");
			expect(result.content).toContain("**Thumbnail:** https://i.vimeocdn.com/video/149847259.jpg");
			expect(result.content).toContain(
				"**Available Qualities:**\n- 1080p: 1920x1080 @ 24fps\n- 720p: 1280x720 @ 24fps",
			);
		});
	});

	describe("coingecko business declaration", () => {
		const coingeckoDecl = BUSINESS_DECLARATIONS.find(d => d.site === "coingecko")!;
		const handler = createBusinessHandler(coingeckoDecl, "handleCoinGecko");

		it("renders cryptocurrency with price formatting, 24h change, ATH date, supply ratios, links, and stripped description", async () => {
			const btcJson = {
				name: "Bitcoin",
				symbol: "btc",
				market_data: {
					current_price: { usd: 65432.1 },
					price_change_percentage_24h: 3.456,
					market_cap: { usd: 1289000000000 },
					total_volume: { usd: 25000000000 },
					ath: { usd: 73750.07 },
					ath_date: { usd: "2024-03-14T07:10:36.635Z" },
					circulating_supply: 19700000,
					max_supply: 21000000,
				},
				genesis_date: "2009-01-03",
				categories: ["Layer 1 (L1)", "Store of Value"],
				links: {
					homepage: ["https://bitcoin.org"],
					blockchain_site: ["https://mempool.space"],
					repos_url: { github: ["https://github.com/bitcoin/bitcoin"] },
				},
				description: { en: "<p>Bitcoin is the first <b>decentralized</b> cryptocurrency.</p>" },
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(btcJson),
				contentType: "application/json",
				finalUrl: "https://api.coingecko.com/api/v3/coins/bitcoin",
				ok: true,
				status: 200,
			}));

			const result = (await handler("https://www.coingecko.com/en/coins/bitcoin", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Bitcoin (BTC)");
			expect(result.content).toContain("**Price:** $65,432.1 (+3.46% 24h)");
			expect(result.content).toContain("**Market Cap:** $1289B");
			expect(result.content).toContain("**24h Volume:** $25B");
			expect(result.content).toContain("**All-Time High:** $73,750.07 (Mar 14, 2024)");
			expect(result.content).toContain("**Circulating Supply:** 20M / 21M (93.8%)");
			expect(result.content).toContain("**Launch Date:** 2009-01-03");
			expect(result.content).toContain("**Categories:** Layer 1 (L1), Store of Value");
			expect(result.content).toContain(
				"**Links:** [Website](https://bitcoin.org) · [Explorer](https://mempool.space) · [GitHub](https://github.com/bitcoin/bitcoin)",
			);
			expect(result.content).toContain("## About\n\nBitcoin is the first decentralized cryptocurrency.");
		});
	});

	describe("opencorporates business declaration", () => {
		const ocDecl = BUSINESS_DECLARATIONS.find(d => d.site === "opencorporates")!;
		const handler = createBusinessHandler(ocDecl, "handleOpenCorporates");

		it("renders full corporate dossier including officers, industry codes, identifiers, and elision on former officers", async () => {
			const ocJson = {
				results: {
					company: {
						name: "ACME Corp",
						company_number: "12345678",
						jurisdiction_code: "us_de",
						current_status: "Active",
						company_type: "Corporation",
						incorporation_date: "2010-01-01",
						registered_address_in_full: "1209 Orange St, Wilmington, DE 19801",
						agent_name: "The Corporation Trust Company",
						agent_address: "1209 Orange St, Wilmington, DE",
						officers: [
							{ officer: { id: 1, name: "Alice Boss", position: "President", start_date: "2010-01-01" } },
							...Array.from({ length: 12 }, (_, i) => ({
								officer: {
									id: 10 + i,
									name: `Former Director ${i + 1}`,
									position: "Director",
									start_date: "2010-01-01",
									end_date: "2015-01-01",
								},
							})),
						],
						industry_codes: [
							{ code: "62010", description: "Computer programming activities", code_scheme_name: "UK SIC 2007" },
						],
						identifiers: [{ identifier_system_code: "lei", identifier_uid: "5493006MHB84DD0ZWV18" }],
						previous_names: [{ company_name: "Old ACME Ltd", con_date: "2012-05-01" }],
						source: { publisher: "Delaware Division of Corporations", url: "https://corp.delaware.gov" },
						registry_url: "https://corp.delaware.gov",
						retrieved_at: "2024-01-01T00:00:00Z",
						opencorporates_url: "https://opencorporates.com/companies/us_de/12345678",
					},
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(ocJson),
				contentType: "application/json",
				finalUrl: "https://api.opencorporates.com/v0.4/companies/us_de/12345678",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://opencorporates.com/companies/us_de/12345678",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# ACME Corp");
			expect(result.content).toContain("| **Company Number** | 12345678 |");
			expect(result.content).toContain("| **Jurisdiction** | US_DE |");
			expect(result.content).toContain("## Registered Address\n\n1209 Orange St, Wilmington, DE 19801");
			expect(result.content).toContain(
				"## Registered Agent\n\n**The Corporation Trust Company**\n1209 Orange St, Wilmington, DE",
			);
			expect(result.content).toContain("## Current Officers (1)\n\n- **Alice Boss** - President (since 2010-01-01)");
			expect(result.content).toContain("## Former Officers (12)\n\n- **Former Director 1**");
			expect(result.content).toContain("- **Former Director 10**");
			expect(result.content).toContain("[…2 former officers elided…]");
			expect(result.content).toContain(
				"## Industry Codes\n\n- **62010**: Computer programming activities (UK SIC 2007)",
			);
			expect(result.content).toContain("## Identifiers\n\n- **lei**: 5493006MHB84DD0ZWV18");
			expect(result.content).toContain("## Previous Names\n\n- Old ACME Ltd (until 2012-05-01)");
			expect(result.content).toContain(
				"**Source:** Delaware Division of Corporations ([registry](https://corp.delaware.gov))",
			);
		});
	});

	describe("sec-edgar business declaration", () => {
		const secDecl = BUSINESS_DECLARATIONS.find(d => d.site === "sec-edgar")!;
		const handler = createBusinessHandler(secDecl, "handleSecEdgar");

		it("renders SEC submissions with CIK normalization, tickers, business address, key filings, and links", async () => {
			const secJson = {
				cik: "0000320193",
				entityType: "operating",
				sic: "3571",
				sicDescription: "ELECTRONIC COMPUTERS",
				name: "Apple Inc.",
				tickers: ["AAPL"],
				exchanges: ["Nasdaq"],
				ein: "942404110",
				stateOfIncorporation: "CA",
				fiscalYearEnd: "0930",
				addresses: {
					business: {
						street1: "ONE APPLE PARK WAY",
						city: "CUPERTINO",
						stateOrCountry: "CA",
						zipCode: "95014",
					},
				},
				filings: {
					recent: {
						accessionNumber: ["0000320193-24-000106", "0000320193-24-000080"],
						filingDate: ["2024-11-01", "2024-08-02"],
						reportDate: ["2024-09-28", "2024-06-29"],
						acceptanceDateTime: ["2024-11-01T16:30:00Z", "2024-08-02T16:30:00Z"],
						form: ["10-K", "10-Q"],
						primaryDocument: ["aapl-20240928.htm", "aapl-20240629.htm"],
						primaryDocDescription: ["ANNUAL REPORT", "QUARTERLY REPORT"],
					},
				},
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(secJson),
				contentType: "application/json",
				finalUrl: "https://data.sec.gov/submissions/CIK0000320193.json",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://www.sec.gov/edgar/browse/?CIK=0000320193",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Apple Inc.");
			expect(result.content).toContain("**CIK:** 0000320193 · **Ticker:** AAPL (Nasdaq)");
			expect(result.content).toContain("**Entity Type:** operating");
			expect(result.content).toContain("**SIC:** 3571 - ELECTRONIC COMPUTERS");
			expect(result.content).toContain("**State of Incorporation:** CA");
			expect(result.content).toContain("**EIN:** 942404110");
			expect(result.content).toContain("**Fiscal Year End:** 09/30");
			expect(result.content).toContain("## Business Address\n\nONE APPLE PARK WAY\nCUPERTINO, CA, 95014");
			expect(result.content).toContain("## Recent Filings (10-K, 10-Q, 8-K)");
			expect(result.content).toContain(
				"| 2024-11-01 | [10-K](https://www.sec.gov/Archives/edgar/data/320193/000032019324000106/aapl-20240928.htm) | ANNUAL REPORT |",
			);
			expect(result.content).toContain("## Links");
			expect(result.content).toContain("SEC EDGAR Filings");
		});
	});

	describe("searchcode business declaration", () => {
		const searchcodeDecl = BUSINESS_DECLARATIONS.find(d => d.site === "searchcode")!;
		const handler = createBusinessHandler(searchcodeDecl, "handleSearchcode");

		it("renders single snippet view with line numbers prefixing code", async () => {
			const viewJson = {
				id: 12345678,
				filename: "quicksort.py",
				repo: "https://github.com/example/algorithms",
				language: "Python",
				lines: "10, 11, 12",
				location: "src/sort/quicksort.py",
				code: "def quicksort(arr):\n    if len(arr) <= 1: return arr\n    return quicksort([x for x in arr[1:] if x < arr[0]])",
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(viewJson),
				contentType: "application/json",
				finalUrl: "https://searchcode.com/api/result/12345678/",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://searchcode.com/codesearch/view/12345678/",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# quicksort.py");
			expect(result.content).toContain("**Repository:** https://github.com/example/algorithms");
			expect(result.content).toContain("**Language:** Python");
			expect(result.content).toContain("**Lines:** 10, 11, 12");
			expect(result.content).toContain(
				"```python\n10: def quicksort(arr):\n11:     if len(arr) <= 1: return arr\n12:     return quicksort([x for x in arr[1:] if x < arr[0]])\n```",
			);
		});

		it("renders search query listing with pagination and elision", async () => {
			const searchJson = {
				query: "quicksort",
				total: 42,
				nextpage: 1,
				results: Array.from({ length: 15 }, (_, i) => ({
					id: 100 + i,
					filename: `sort_${i + 1}.py`,
					repo: "https://github.com/example/repo",
					language: "Python",
					code: "def sort(): pass",
				})),
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(searchJson),
				contentType: "application/json",
				finalUrl: "https://searchcode.com/api/codesearch_I/?q=quicksort&p=0",
				ok: true,
				status: 200,
			}));

			const result = (await handler("https://searchcode.com/?q=quicksort", 10)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# Searchcode Results");
			expect(result.content).toContain("**Query:** `quicksort`");
			expect(result.content).toContain("**Total Results:** 42");
			expect(result.content).toContain("### sort_1.py");
			expect(result.content).toContain("### sort_10.py");
			expect(result.content).toContain("_Only showing first 10 results._");
			expect(result.content).not.toContain("### sort_11.py");
		});
	});

	describe("cisa-kev security advisory declaration", () => {
		const cisaDecl = SECURITY_ADVISORY_DECLARATIONS.find(d => d.site === "cisa-kev")!;
		const handler = createSecurityAdvisoryHandler(cisaDecl, "handleCisaKev");

		it("renders vulnerability with vendor, product, dates, description, and required action", async () => {
			const kevJson = {
				vulnerabilities: [
					{
						cveID: "CVE-2023-34362",
						vendorProject: "Progress",
						product: "MOVEit Transfer",
						vulnerabilityName: "Progress MOVEit Transfer SQL Injection Vulnerability",
						dateAdded: "2023-06-02",
						dueDate: "2023-06-23",
						shortDescription: "Progress MOVEit Transfer contains a SQL injection vulnerability.",
						requiredAction: "Apply mitigations per vendor instructions.",
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(kevJson),
				contentType: "application/json",
				finalUrl: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search=CVE-2023-34362",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# CVE-2023-34362");
			expect(result.content).toContain("Progress MOVEit Transfer SQL Injection Vulnerability");
			expect(result.content).toContain("**Vendor:** Progress");
			expect(result.content).toContain("**Product:** MOVEit Transfer");
			expect(result.content).toContain("**Date Added:** 2023-06-02");
			expect(result.content).toContain("**Due Date:** 2023-06-23");
			expect(result.content).toContain(
				"## Description\n\nProgress MOVEit Transfer contains a SQL injection vulnerability.",
			);
			expect(result.content).toContain("## Required Action\n\nApply mitigations per vendor instructions.");
		});
	});

	describe("nvd security advisory declaration", () => {
		const nvdDecl = SECURITY_ADVISORY_DECLARATIONS.find(d => d.site === "nvd")!;
		const handler = createSecurityAdvisoryHandler(nvdDecl, "handleNvd");

		it("renders full CVSS 3.1 & 2.0 metrics with vector strings, exploitability/impact scores, weaknesses, CPEs with elision, and references", async () => {
			const cpes = Array.from({ length: 25 }, (_, i) => `cpe:2.3:a:apache:log4j:2.${i}:*:*:*:*:*:*:*`);
			const refs = Array.from({ length: 20 }, (_, i) => ({
				url: `https://example.com/advisory/${i + 1}`,
				tags: ["Vendor Advisory", "Patch"],
			}));

			const nvdJson = {
				vulnerabilities: [
					{
						cve: {
							id: "CVE-2021-44228",
							vulnStatus: "Analyzed",
							published: "2021-12-10T10:15:08.000",
							lastModified: "2023-11-07T03:39:26.000",
							descriptions: [
								{
									lang: "en",
									value: "Apache Log4j2 2.0-beta9 through 2.15.0 JNDI features do not protect against attacker controlled LDAP.",
								},
							],
							metrics: {
								cvssMetricV31: [
									{
										cvssData: {
											baseScore: 10.0,
											baseSeverity: "CRITICAL",
											vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
										},
										exploitabilityScore: 3.9,
										impactScore: 6.0,
									},
								],
								cvssMetricV2: [
									{
										cvssData: {
											baseScore: 9.3,
											vectorString: "(AV:N/AC:M/Au:N/C:C/I:C/A:C)",
										},
										severity: "HIGH",
									},
								],
							},
							weaknesses: [
								{
									description: [
										{ lang: "en", value: "CWE-502" },
										{ lang: "en", value: "NVD-CWE-noinfo" },
									],
								},
							],
							configurations: [
								{
									nodes: [
										{
											cpeMatch: cpes.map(cpe => ({ criteria: cpe, vulnerable: true })),
										},
									],
								},
							],
							references: refs,
						},
					},
				],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(nvdJson),
				contentType: "application/json",
				finalUrl: "https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://nvd.nist.gov/vuln/detail/CVE-2021-44228",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# CVE-2021-44228");
			expect(result.content).toContain("**Status:** Analyzed");
			expect(result.content).toContain("**Published:** 2021-12-10 · **Modified:** 2023-11-07");
			expect(result.content).toContain("## Description\n\nApache Log4j2");
			expect(result.content).toContain("## CVSS Scores");
			expect(result.content).toContain(
				"### CVSS 3.1\n\n- **Base Score:** 10 (CRITICAL)\n- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H`\n- **Exploitability:** 3.9\n- **Impact:** 6",
			);
			expect(result.content).toContain(
				"### CVSS 2.0\n\n- **Base Score:** 9.3 (HIGH)\n- **Vector:** `(AV:N/AC:M/Au:N/C:C/I:C/A:C)`",
			);
			expect(result.content).toContain("## Weaknesses\n\n- CWE-502");
			expect(result.content).not.toContain("NVD-CWE-noinfo");
			expect(result.content).toContain("## Affected Products\n\n- `cpe:2.3:a:apache:log4j:2.0:*:*:*:*:*:*:*`");
			expect(result.content).toContain("[…5 CPEs elided…]");
			expect(result.content).toContain("## References\n\n- https://example.com/advisory/1 (Vendor Advisory, Patch)");
			expect(result.content).toContain("[…5 references elided…]");
		});
	});

	describe("osv security advisory declaration", () => {
		const osvDecl = SECURITY_ADVISORY_DECLARATIONS.find(d => d.site === "osv")!;
		const handler = createSecurityAdvisoryHandler(osvDecl, "handleOsv");

		it("renders vulnerability with aliases, dates, severity, multi-range events, version lists with elision, typed references, and credits", async () => {
			const versions = Array.from({ length: 15 }, (_, i) => `1.0.${i}`);

			const osvJson = {
				id: "GHSA-j954-5h4q-8xwp",
				summary: "Remote code execution in example-pkg",
				details: "Attackers can execute arbitrary code via malformed payload.",
				aliases: ["CVE-2024-99999"],
				published: "2024-01-15T12:00:00Z",
				modified: "2024-01-16T12:00:00Z",
				withdrawn: "2024-01-20T12:00:00Z",
				severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
				affected: [
					{
						package: { ecosystem: "npm", name: "example-pkg" },
						ranges: [
							{
								type: "ECOSYSTEM",
								events: [{ introduced: "1.0.0", fixed: "1.2.0", last_affected: "1.1.9", limit: "2.0.0" }],
							},
						],
						versions,
					},
				],
				references: [{ type: "ADVISORY", url: "https://github.com/advisories/GHSA-j954-5h4q-8xwp" }],
				credits: [{ name: "Security Researcher", type: "FINDER" }],
			};

			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
				content: JSON.stringify(osvJson),
				contentType: "application/json",
				finalUrl: "https://api.osv.dev/v1/vulns/GHSA-j954-5h4q-8xwp",
				ok: true,
				status: 200,
			}));

			const result = (await handler(
				"https://osv.dev/vulnerability/GHSA-j954-5h4q-8xwp",
				10,
			)) as scraperTypes.RenderResult;
			expect(result).not.toBeNull();
			expect(result.content).toContain("# GHSA-j954-5h4q-8xwp");
			expect(result.content).toContain("Remote code execution in example-pkg");
			expect(result.content).toContain("## Metadata");
			expect(result.content).toContain("**Aliases:** CVE-2024-99999");
			expect(result.content).toContain("**Published:** 2024-01-15");
			expect(result.content).toContain("**Modified:** 2024-01-16");
			expect(result.content).toContain("**Withdrawn:** 2024-01-20");
			expect(result.content).toContain("**Severity:** CVSS_V3: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
			expect(result.content).toContain("## Details\n\nAttackers can execute arbitrary code via malformed payload.");
			expect(result.content).toContain("## Affected Packages\n\n### npm: example-pkg");
			expect(result.content).toContain(
				"- **ECOSYSTEM:** introduced: 1.0.0 → fixed: 1.2.0 → last_affected: 1.1.9 → limit: 2.0.0",
			);
			expect(result.content).toContain(
				"- **Versions:** 1.0.0, 1.0.1, 1.0.2, 1.0.3, 1.0.4, 1.0.5, 1.0.6, 1.0.7, 1.0.8, 1.0.9… (15 total)",
			);
			expect(result.content).toContain(
				"## References\n\n- [ADVISORY](https://github.com/advisories/GHSA-j954-5h4q-8xwp)",
			);
			expect(result.content).toContain("## Credits\n\n- Security Researcher (FINDER)");
		});
	});
});
