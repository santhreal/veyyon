/**
 * Skyway's pages and handlers over one {@link TravelWorld}, with PayBox started beside it as the
 * origin of the payment frame.
 *
 * What makes it hard to operate is ordinary web design: airports chosen from a type-ahead list,
 * dates from a calendar popover with no typed input, travellers from a stepper popover, results
 * that load behind a spinner with filters, a sort listbox and a "show more" button, layovers only in
 * collapsed flight details, child prices only in a fare's details, a pre-ticked insurance box, card
 * fields in another origin's frame, a seat map of blank buttons named only by their title, and
 * change costs that appear only when a replacement flight is reviewed.
 */

import { Seeded } from "../../../../engine/kit/seeded";
import {
	escapeHtml,
	formFields,
	hostSite,
	html,
	json,
	jsonBody,
	redirect,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { money, page } from "../../ui";
import {
	AIRPORTS,
	addDays,
	ageOn,
	airlineByCode,
	airportByCode,
	arriveOf,
	type BookedLeg,
	type Booking,
	bookLeg,
	type ChangeQuote,
	cancellationRefundCents,
	childFareCents,
	cityOf,
	clock,
	departOf,
	durationText,
	type FareFamily,
	familyById,
	fareFamily,
	findBooking,
	findItinerary,
	flightKey,
	INSURANCE_CENTS,
	type Itinerary,
	isIsoDate,
	isLegroom,
	itinerariesOn,
	LEGROOM_ROWS,
	LEGROOM_SEAT_CENTS,
	layoversOf,
	longDate,
	newBookingRef,
	parseSeat,
	quoteChange,
	quoteTrip,
	SEAT_LETTERS,
	SEAT_ROWS,
	STANDARD_SEAT_CENTS,
	seatFeeCents,
	seatPosition,
	shortDate,
	stopsOf,
	TAX_CENTS,
	type Traveller,
	type TravellerType,
	type TravelWorld,
	takenSeats,
} from "./data";
import { type Charge, fieldsOf, MERCHANT_KEY, startPayBox } from "./paybox";
import {
	CHECKOUT_SCRIPT,
	COMBOBOX_SCRIPT,
	CONFIRM_FREE_SCRIPT,
	COOKIE_SCRIPT,
	DATE_PICKER_SCRIPT,
	PAYMENT_SCRIPT,
	RESULTS_SCRIPT,
	SEARCH_FORM_SCRIPT,
	SEATS_SCRIPT,
	SITE_STYLE,
	scriptJson,
	TRAVELLERS_SCRIPT,
} from "./scripts";

export interface ChangeRecord {
	readonly ref: string;
	readonly leg: number;
	readonly fromItinerary: string;
	readonly toItinerary: string;
	readonly feeCents: number;
	readonly differenceCents: number;
	readonly chargeId: string | null;
}

export interface TravelSnapshot {
	readonly today: string;
	readonly bookings: readonly Booking[];
	/** What PayBox charged, in order. */
	readonly charges: readonly Charge[];
	readonly changes: readonly ChangeRecord[];
	/** References of the bookings cancelled during the trial. */
	readonly cancellations: readonly string[];
	readonly failedSignins: number;
}

export interface TravelSite {
	readonly origin: string;
	/** PayBox, whose frame the checkout embeds. */
	readonly payOrigin: string;
	close(): Promise<void>;
	finish(): Promise<TravelSnapshot>;
}

interface Search {
	readonly trip: "round" | "oneway";
	readonly from: string;
	readonly to: string;
	readonly depart: string;
	/** The return date of a round trip, "" for one way. */
	readonly ret: string;
	readonly adults: number;
	readonly children: number;
}

interface Selection {
	readonly itineraryId: string;
	readonly familyId: string;
}

/** A booking being made: the search, a fare per leg, the travellers, and the insurance box. */
interface Draft {
	readonly search: Search;
	readonly legs: Selection[];
	travellers: Traveller[] | null;
	insurance: boolean;
}

interface Slot {
	readonly type: TravellerType;
	readonly label: string;
}

const SESSION_COOKIE = "sky_sid";
/** Nothing is sold further ahead than this. */
const HORIZON_DAYS = 330;
const TRAVELLER_FIELDS = ["first", "last", "dob", "passport"] as const;

const SORTS: Readonly<
	Record<string, { readonly label: string; readonly order: (a: Itinerary, b: Itinerary) => number }>
> = {
	recommended: {
		label: "Recommended",
		order: (a, b) => recommendation(a) - recommendation(b),
	},
	price: { label: "Lowest price", order: (a, b) => (a.fares[0] as number) - (b.fares[0] as number) },
	duration: {
		label: "Shortest trip",
		order: (a, b) => arriveOf(a) - departOf(a) - (arriveOf(b) - departOf(b)),
	},
	departure: { label: "Earliest departure", order: (a, b) => departOf(a) - departOf(b) },
};

/** Cheap and short first, the way the site ranks by default. */
function recommendation(itinerary: Itinerary): number {
	return (
		(itinerary.fares[0] as number) / 100 + (arriveOf(itinerary) - departOf(itinerary)) * 0.6 + stopsOf(itinerary) * 35
	);
}

const COOKIE_BANNER = `<div id="cookie-banner" class="cookie" role="region" aria-label="Cookie consent">
<p>Skyway uses cookies to remember your searches and to show you offers that match your trips.</p>
<button type="button" data-choice="all">Accept all cookies</button>
<button type="button" class="secondary" data-choice="necessary">Necessary cookies only</button>
</div>`;

function parseSearch(values: Readonly<Record<string, string | undefined>>, today: string): Search | string {
	const trip = values.trip === "oneway" ? "oneway" : "round";
	const from = (values.from ?? "").toUpperCase();
	const to = (values.to ?? "").toUpperCase();
	if (!airportByCode(from)) return "Choose where you fly from in the list of airports.";
	if (!airportByCode(to)) return "Choose where you fly to in the list of airports.";
	if (from === to) return "Choose two different airports.";
	const last = addDays(today, HORIZON_DAYS);
	const depart = values.depart ?? "";
	if (!isIsoDate(depart) || depart < today || depart > last) return "Choose a departure date in the calendar.";
	const ret = trip === "round" ? (values.return ?? "") : "";
	if (trip === "round" && (!isIsoDate(ret) || ret < depart || ret > last)) {
		return "Choose a return date on or after the departure date.";
	}
	const adults = Number(values.adults ?? "1");
	const children = Number(values.children ?? "0");
	if (
		!Number.isInteger(adults) ||
		!Number.isInteger(children) ||
		adults < 1 ||
		adults > 6 ||
		children < 0 ||
		children > 5 ||
		adults + children > 7
	) {
		return "Choose one to six adults and up to five children.";
	}
	return { trip, from, to, depart, ret, adults, children };
}

function searchQuery(search: Search, extra: Readonly<Record<string, string>> = {}): string {
	const params = new URLSearchParams({ trip: search.trip, from: search.from, to: search.to, depart: search.depart });
	if (search.trip === "round") params.set("return", search.ret);
	params.set("adults", String(search.adults));
	params.set("children", String(search.children));
	for (const [key, value] of Object.entries(extra)) params.set(key, value);
	return params.toString();
}

/** Whether two searches agree on everything but the return date, which the return leg's page may move. */
function sameOutbound(a: Search, b: Search): boolean {
	return searchQuery({ ...a, ret: "" }) === searchQuery({ ...b, ret: "" });
}

function travellersText(adults: number, children: number): string {
	const parts = [`${adults} ${adults === 1 ? "adult" : "adults"}`];
	if (children > 0) parts.push(`${children} ${children === 1 ? "child" : "children"}`);
	return parts.join(", ");
}

function legNames(count: number): string[] {
	return count === 2 ? ["Outbound", "Return"] : ["Flight"];
}

function changesText(family: FareFamily): string {
	if (family.changeFeeCents === null) return "No changes";
	return family.changeFeeCents === 0 ? "Free changes" : `Changes: ${money(family.changeFeeCents)} fee`;
}

function seatsText(family: FareFamily): string {
	if (!family.freeStandardSeats) return `Seat choice from ${money(STANDARD_SEAT_CENTS)} per flight`;
	if (family.freeLegroomSeats) return "Any seat free, extra legroom included";
	return `Standard seats free, extra legroom ${money(LEGROOM_SEAT_CENTS)}`;
}

function fareSummary(family: FareFamily): string {
	return [
		family.cabin,
		family.carryOn ? "carry-on bag" : "no carry-on bag",
		family.checkedBags ? `${family.checkedBags} checked bag${family.checkedBags > 1 ? "s" : ""}` : "no checked bag",
		changesText(family).toLowerCase(),
		family.refundable ? "refundable" : "non-refundable",
	].join(" · ");
}

/** `DD/MM/YYYY` from an ISO date. */
function dayMonthYear(date: string): string {
	return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

function segmentLine(segment: {
	flightNo: string;
	from: string;
	to: string;
	departMin: number;
	arriveMin: number;
}): string {
	return `${escapeHtml(segment.flightNo)} · ${escapeHtml(cityOf(segment.from))} (${segment.from}) ${clock(segment.departMin)} → ${escapeHtml(cityOf(segment.to))} (${segment.to}) ${clock(segment.arriveMin)}${segment.arriveMin >= 1440 ? " (next day)" : ""}`;
}

function itineraryView(itinerary: Itinerary) {
	return {
		id: itinerary.id,
		airline: itinerary.airline,
		airlineName: airlineByCode(itinerary.airline).name,
		depart: clock(departOf(itinerary)),
		arrive: clock(arriveOf(itinerary)),
		nextDay: arriveOf(itinerary) >= 1440,
		durationText: durationText(arriveOf(itinerary) - departOf(itinerary)),
		stops: stopsOf(itinerary),
		layovers: layoversOf(itinerary).map(layover => ({
			airport: layover.airport,
			city: cityOf(layover.airport),
			minutes: layover.minutes,
			text: durationText(layover.minutes),
		})),
		segments: itinerary.segments.map(segment => ({
			flightNo: segment.flightNo,
			from: segment.from,
			to: segment.to,
			fromCity: cityOf(segment.from),
			toCity: cityOf(segment.to),
			depart: clock(segment.departMin),
			arrive: clock(segment.arriveMin),
			nextDay: segment.arriveMin >= 1440,
			duration: durationText(segment.arriveMin - segment.departMin),
		})),
		fromCents: itinerary.fares[0],
		fares: itinerary.fares.map((adultCents, tier) => {
			const family = fareFamily(itinerary.airline, tier);
			return {
				id: family.id,
				name: family.name,
				cabin: family.cabin,
				carryOn: family.carryOn,
				checkedBags: family.checkedBags,
				refundable: family.refundable,
				changes: changesText(family),
				seats: seatsText(family),
				adultCents,
				childCents: childFareCents(adultCents, family),
			};
		}),
	};
}

function combobox(name: string, label: string, code: string): string {
	const airport = airportByCode(code);
	return `<div class="combo" data-combobox="${name}">
<label for="${name}-input">${label}</label>
<input id="${name}-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${name}-listbox" autocomplete="off" placeholder="City or airport" value="${airport ? escapeHtml(`${airport.city} (${airport.code})`) : ""}">
<input type="hidden" name="${name}" value="${airport ? airport.code : ""}">
<ul id="${name}-listbox" role="listbox" aria-label="${label} airports" hidden></ul>
</div>`;
}

function datePicker(name: string, label: string, min: string, max: string, value: string): string {
	return `<div class="dp" data-datepicker="${name}" data-min="${min}" data-max="${max}">
<label for="${name}-input">${label}</label>
<input id="${name}-input" class="dp-text" type="text" readonly placeholder="Choose a date" aria-haspopup="dialog" aria-expanded="false">
<input type="hidden" name="${name}" value="${escapeHtml(value)}">
<div class="dp-pop" role="dialog" aria-label="Choose the ${label.toLowerCase()} date" hidden>
<div class="dp-head"><button type="button" class="dp-prev secondary" aria-label="Previous month">‹</button><strong class="dp-title" aria-live="polite"></strong><button type="button" class="dp-next secondary" aria-label="Next month">›</button></div>
<div class="dp-week">${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(day => `<span>${day}</span>`).join("")}</div>
<div class="dp-days"></div>
</div>
</div>`;
}

function paxControl(adults: number, children: number): string {
	const row = (kind: string, label: string, hint: string, count: number, singular: string) =>
		`<div class="pax-row"><span>${label} <small class="muted">${hint}</small></span><button type="button" class="secondary" data-kind="${kind}" data-by="-1" aria-label="Remove ${singular}">−</button><output data-count="${kind}">${count}</output><button type="button" class="secondary" data-kind="${kind}" data-by="1" aria-label="Add ${singular}">+</button></div>`;
	return `<div class="pax" data-pax>
<label for="pax-toggle">Travellers</label>
<button type="button" id="pax-toggle" class="secondary pax-toggle" aria-expanded="false" aria-controls="pax-pop">${travellersText(adults, children)}</button>
<input type="hidden" name="adults" value="${adults}"><input type="hidden" name="children" value="${children}">
<div id="pax-pop" class="pax-pop" role="dialog" aria-label="Travellers" hidden>
${row("adults", "Adults", "12+", adults, "an adult")}
${row("children", "Children", "2–11", children, "a child")}
<button type="button" class="pax-done">Done</button>
</div>
</div>`;
}

function hiddenFields(values: Readonly<Record<string, string>>): string {
	return Object.entries(values)
		.map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
		.join("");
}

function travellerSlots(adults: number, children: number): Slot[] {
	return [
		...Array.from({ length: adults }, (_, i): Slot => ({ type: "adult", label: `Adult ${i + 1}` })),
		...Array.from({ length: children }, (_, i): Slot => ({ type: "child", label: `Child ${i + 1}` })),
	];
}

/** An ISO date from `DD/MM/YYYY`, or null. */
function parseDayMonthYear(value: string): string | null {
	const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
	if (!match) return null;
	const iso = `${match[3]}-${(match[2] as string).padStart(2, "0")}-${(match[1] as string).padStart(2, "0")}`;
	return isIsoDate(iso) ? iso : null;
}

export async function startTravelSite(world: TravelWorld, seed: number): Promise<TravelSite> {
	const rng = new Seeded(seed ^ 0x7a11);
	const paybox = await startPayBox({
		today: world.today,
		customer: world.account.email,
		savedCardLast4: world.savedCardLast4,
		rng: new Seeded(seed ^ 0x9a7b),
	});
	const signedIn = new Set<string>();
	const consented = new Set<string>();
	const drafts = new Map<string, Draft>();
	const changes: ChangeRecord[] = [];
	const cancellations: string[] = [];
	let failedSignins = 0;
	let origin = "";
	const lastDay = addDays(world.today, HORIZON_DAYS);

	const sessionOf = (request: SiteRequest): { id: string; fresh: boolean } => {
		const existing = request.cookies[SESSION_COOKIE];
		return existing ? { id: existing, fresh: false } : { id: `s${rng.code(12)}`, fresh: true };
	};

	const nav = (session: string) =>
		`<a href="/">Flights</a><a href="/trips">My trips</a>${
			signedIn.has(session)
				? `<a href="/account">Profile</a><a href="/signout">Sign out</a>`
				: `<a href="/signin">Sign in</a>`
		}`;

	const render = (session: string, title: string, body: string, script = ""): SiteResponse => {
		const banner = !consented.has(session);
		return html(
			page(title, `${body}${banner ? COOKIE_BANNER : ""}`, {
				brand: "Skyway",
				nav: nav(session),
				style: SITE_STYLE,
				script: `${script}${banner ? COOKIE_SCRIPT : ""}`,
			}),
		);
	};

	const payFrame = (amountCents: number) =>
		`${paybox.origin}/frame?${new URLSearchParams({
			amount: String(amountCents),
			merchant: "Skyway",
			parent: origin,
			customer: world.account.email,
		}).toString()}`;

	const paymentConfig = (url: string, body: Readonly<Record<string, unknown>>) =>
		`const PAYMENT = ${scriptJson({ origin: paybox.origin, url, body })};`;

	const chargeToken = async (
		token: string,
		amountCents: number,
		description: string,
	): Promise<{ id: string } | { error: string }> => {
		const response = await fetch(`${paybox.origin}/api/charges`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${MERCHANT_KEY}` },
			body: JSON.stringify({ token, amountCents, description }),
		});
		const result = fieldsOf(await response.json());
		if (response.ok && typeof result.id === "string") return { id: result.id };
		return { error: typeof result.error === "string" ? result.error : "The payment was declined." };
	};

	// -----------------------------------------------------------------------------------------
	// Search

	const home = (session: string, values: Readonly<Record<string, string>>, error = "") => {
		const round = values.trip !== "oneway";
		const adults = Number(values.adults) || 1;
		const children = Number(values.children) || 0;
		return render(
			session,
			"Skyway: find flights",
			`<h1>Find flights</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form id="search-form" class="card" method="get" action="/flights" novalidate>
<div role="radiogroup" aria-label="Trip type">
<label class="inline"><input type="radio" name="trip" value="round"${round ? " checked" : ""}> Round trip</label>
<label class="inline"><input type="radio" name="trip" value="oneway"${round ? "" : " checked"}> One way</label>
</div>
<div class="search-grid">
${combobox("from", "From", values.from ?? "")}
${combobox("to", "To", values.to ?? "")}
${datePicker("depart", "Depart", world.today, lastDay, isIsoDate(values.depart ?? "") ? (values.depart as string) : "")}
<div id="return-field">${datePicker("return", "Return", isIsoDate(values.depart ?? "") ? (values.depart as string) : world.today, lastDay, isIsoDate(values.return ?? "") ? (values.return as string) : "")}</div>
${paxControl(adults, children)}
</div>
<p class="error" id="search-error" role="alert"></p>
<button>Search flights</button>
</form>
<p class="muted">Fares are per adult and include no taxes until checkout. Children's fares are shown in each fare's details.</p>`,
			`${COMBOBOX_SCRIPT}${DATE_PICKER_SCRIPT}${SEARCH_FORM_SCRIPT}`,
		);
	};

	const airportsApi = (url: URL) => {
		const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
		if (query.length < 2) return json([]);
		const matches = AIRPORTS.filter(airport =>
			[airport.city, airport.name, airport.code].some(value => value.toLowerCase().includes(query)),
		).sort(
			(a, b) => Number(!a.city.toLowerCase().startsWith(query)) - Number(!b.city.toLowerCase().startsWith(query)),
		);
		return json(matches.slice(0, 8).map(airport => ({ code: airport.code, city: airport.city, name: airport.name })));
	};

	const searchApi = (url: URL): SiteResponse => {
		const params = url.searchParams;
		const from = params.get("from") ?? "";
		const to = params.get("to") ?? "";
		const date = params.get("date") ?? "";
		if (!airportByCode(from) || !airportByCode(to) || !isIsoDate(date)) {
			return json({ error: "Name two airports and a date." }, { status: 400 });
		}
		if (date < world.today || date > lastDay) return json({ total: 0, items: [] });
		const list = (name: string, all: readonly string[]) =>
			params.has(name) ? (params.get(name) ?? "").split(",").filter(Boolean) : [...all];
		const stops = list("stops", ["0", "1", "2"]).map(Number);
		const airlines = list(
			"airlines",
			itinerariesOn(world, from, to, date).map(itinerary => itinerary.airline),
		);
		const earliest = Number(params.get("depMin") ?? "0") * 60;
		const latest = Number(params.get("depMax") ?? "24") * 60;
		const sort = SORTS[params.get("sort") ?? ""] ?? SORTS.recommended;
		const offset = Math.max(0, Math.floor(Number(params.get("offset") ?? "0")) || 0);
		const limit = Math.min(20, Math.max(1, Math.floor(Number(params.get("limit") ?? "6")) || 6));
		const matches = itinerariesOn(world, from, to, date)
			.filter(itinerary => stops.includes(Math.min(2, stopsOf(itinerary))))
			.filter(itinerary => airlines.includes(itinerary.airline))
			.filter(itinerary => departOf(itinerary) >= earliest && departOf(itinerary) <= latest)
			.sort(sort.order);
		return json({ total: matches.length, items: matches.slice(offset, offset + limit).map(itineraryView) });
	};

	const draftLegs = (draft: Draft): { itinerary: Itinerary; family: FareFamily }[] | null => {
		const legs: { itinerary: Itinerary; family: FareFamily }[] = [];
		for (const selection of draft.legs) {
			const itinerary = findItinerary(world, selection.itineraryId);
			const family = familyById(selection.familyId);
			if (!itinerary || !family) return null;
			legs.push({ itinerary, family });
		}
		return legs.length === (draft.search.trip === "round" ? 2 : 1) ? legs : null;
	};

	const quoteDraft = (draft: Draft, legs: readonly { itinerary: Itinerary; family: FareFamily }[]) =>
		quoteTrip(
			legs.map(leg => ({ family: leg.family, adultCents: leg.itinerary.fares[leg.family.tier] as number })),
			draft.search.adults,
			draft.search.children,
			draft.insurance,
		);

	const resultsPage = (session: string, search: Search, leg: 0 | 1): SiteResponse => {
		const draft = drafts.get(session);
		const outbound = leg === 1 && draft && sameOutbound(draft.search, search) && draft.legs[0] ? draft.legs[0] : null;
		if (leg === 1 && !outbound) return redirect(`/flights?${searchQuery(search)}`);
		const [from, to, date] =
			leg === 0 ? [search.from, search.to, search.depart] : [search.to, search.from, search.ret];
		const list = itinerariesOn(world, from, to, date);
		const airlines = [...new Set(list.map(itinerary => itinerary.airline))].sort();
		const strip = [-3, -2, -1, 0, 1, 2, 3]
			.map(offset => {
				const day = addDays(date, offset);
				const allowed =
					day >= world.today &&
					day <= lastDay &&
					(leg === 0 ? search.trip === "oneway" || day <= search.ret : day >= search.depart);
				if (!allowed) {
					return `<span class="day disabled" aria-disabled="true">${escapeHtml(shortDate(day))}<strong>–</strong></span>`;
				}
				const cheapest = Math.min(
					...itinerariesOn(world, from, to, day).map(itinerary => itinerary.fares[0] as number),
				);
				const next = leg === 0 ? { ...search, depart: day } : { ...search, ret: day };
				return `<a class="day${offset === 0 ? " current" : ""}" href="/flights?${escapeHtml(searchQuery(next, leg === 1 ? { leg: "1" } : {}))}"${offset === 0 ? ' aria-current="date"' : ""}>${escapeHtml(shortDate(day))}<strong>from ${money(cheapest)}</strong></a>`;
			})
			.join("");
		const chosen = (() => {
			if (!outbound) return "";
			const itinerary = findItinerary(world, outbound.itineraryId);
			const family = familyById(outbound.familyId);
			if (!itinerary || !family) return "";
			return `<div class="card chosen"><strong>Outbound chosen:</strong> ${itinerary.segments.map(segment => escapeHtml(segment.flightNo)).join(", ")} · ${escapeHtml(shortDate(itinerary.date))} ${clock(departOf(itinerary))} → ${clock(arriveOf(itinerary))} · ${escapeHtml(family.name)} · ${money(itinerary.fares[family.tier] as number)} per adult <a href="/flights?${escapeHtml(searchQuery(search))}">Change</a></div>`;
		})();
		const sortOptions = Object.entries(SORTS)
			.map(
				([value, sort]) =>
					`<li role="option" data-value="${value}" aria-selected="${value === "recommended"}">${sort.label}</li>`,
			)
			.join("");
		return render(
			session,
			leg === 0 ? "Choose your outbound flight" : "Choose your return flight",
			`<div class="card row" style="justify-content:space-between"><div><strong>${escapeHtml(cityOf(search.from))} (${search.from}) ${search.trip === "round" ? "⇄" : "→"} ${escapeHtml(cityOf(search.to))} (${search.to})</strong> · ${escapeHtml(shortDate(search.depart))}${search.trip === "round" ? ` – ${escapeHtml(shortDate(search.ret))}` : ""} · ${travellersText(search.adults, search.children)}</div><a href="/?${escapeHtml(searchQuery(search))}">Change search</a></div>
<h1>${leg === 0 ? (search.trip === "round" ? "Choose your outbound flight" : "Choose your flight") : "Choose your return flight"}</h1>
<p class="muted">${search.trip === "round" ? `Step ${leg + 1} of 2 · ` : ""}${escapeHtml(cityOf(from))} to ${escapeHtml(cityOf(to))} on ${escapeHtml(longDate(date))}</p>
${chosen}
<nav class="strip" aria-label="Nearby dates">${strip}</nav>
<div class="results-layout">
<form class="card filters" id="filters" aria-label="Filters" onsubmit="return false">
<fieldset><legend>Stops</legend>
<label class="inline"><input type="checkbox" name="stops" value="0" checked> Nonstop</label>
<label class="inline"><input type="checkbox" name="stops" value="1" checked> 1 stop</label>
<label class="inline"><input type="checkbox" name="stops" value="2" checked> 2+ stops</label>
</fieldset>
<fieldset><legend>Airlines</legend>${airlines
				.map(
					code =>
						`<label class="inline"><input type="checkbox" name="airlines" value="${code}" checked> ${escapeHtml(airlineByCode(code).name)}</label>`,
				)
				.join("")}</fieldset>
<fieldset><legend>Departure time</legend>
<label for="dep-min">Leaves after <output id="dep-min-out">00:00</output></label><input type="range" id="dep-min" min="0" max="24" step="1" value="0">
<label for="dep-max">Leaves before <output id="dep-max-out">24:00</output></label><input type="range" id="dep-max" min="0" max="24" step="1" value="24">
</fieldset>
</form>
<section>
<div class="row" style="justify-content:space-between"><span id="result-count" class="muted" role="status"></span>
<div class="sort"><button type="button" class="secondary" id="sort-button" aria-haspopup="listbox" aria-expanded="false">Sort: Recommended</button><ul id="sort-options" role="listbox" aria-label="Sort flights" hidden>${sortOptions}</ul></div></div>
<div id="spinner" class="spinner" role="status"><span class="spin"></span> Searching flights…</div>
<div id="results"></div>
<p><button type="button" id="more" class="secondary" hidden>Show more flights</button></p>
</section>
</div>
<form id="choose" method="post" action="/book/select" hidden>${hiddenFields({
				trip: search.trip,
				from: search.from,
				to: search.to,
				depart: search.depart,
				return: search.ret,
				adults: String(search.adults),
				children: String(search.children),
				leg: String(leg),
				itinerary: "",
				fare: "",
			})}</form>`,
			`const RESULTS = ${scriptJson({ from, to, date, leg })};${RESULTS_SCRIPT}`,
		);
	};

	const selectFare = (session: string, fields: Record<string, string>): SiteResponse => {
		const search = parseSearch(fields, world.today);
		if (typeof search === "string") return home(session, fields, search);
		const leg = fields.leg === "1" && search.trip === "round" ? 1 : 0;
		const [from, to, date] =
			leg === 0 ? [search.from, search.to, search.depart] : [search.to, search.from, search.ret];
		const itinerary = itinerariesOn(world, from, to, date).find(entry => entry.id === fields.itinerary);
		const family = familyById(fields.fare ?? "");
		if (!itinerary || !family || family.airline !== itinerary.airline) {
			return text("That flight or fare is no longer available. Go back and search again.", { status: 400 });
		}
		const selection = { itineraryId: itinerary.id, familyId: family.id };
		if (leg === 0) {
			drafts.set(session, { search, legs: [selection], travellers: null, insurance: true });
			return redirect(
				search.trip === "round" ? `/flights?${searchQuery(search, { leg: "1" })}` : "/book/travellers",
			);
		}
		const draft = drafts.get(session);
		const outbound = draft?.legs[0];
		if (!draft || !outbound || !sameOutbound(draft.search, search))
			return redirect(`/flights?${searchQuery(search)}`);
		drafts.set(session, { search, legs: [outbound, selection], travellers: null, insurance: draft.insurance });
		return redirect("/book/travellers");
	};

	// -----------------------------------------------------------------------------------------
	// Booking

	const travellersPage = (
		session: string,
		draft: Draft,
		errors: readonly string[] = [],
		values: Record<string, string> = {},
	) => {
		const slots = travellerSlots(draft.search.adults, draft.search.children);
		const fieldsets = slots
			.map((slot, i) => {
				const input = (field: string, label: string, extra = "") =>
					`<label>${label} <input name="t${i}_${field}" value="${escapeHtml(values[`t${i}_${field}`] ?? "")}" autocomplete="off"${extra}></label>`;
				return `<fieldset class="card"><legend>${slot.label}${slot.type === "child" ? ' <small class="muted">2 to 11 years old on the day of travel</small>' : ""}</legend>
${i === 0 ? '<p><button type="button" class="secondary" id="fill-profile">Fill in my details</button></p>' : ""}
<div class="row">${input("first", "First name")}${input("last", "Last name")}</div>
<div class="row">${input("dob", "Date of birth", ' placeholder="DD/MM/YYYY"')}${input("passport", "Passport number", ' placeholder="AB1234567"')}</div>
</fieldset>`;
			})
			.join("");
		const account = world.account;
		return render(
			session,
			"Travellers",
			`<h1>Who is travelling?</h1>
<p class="muted">Enter each traveller as written in their passport.</p>
${errors.map(error => `<p class="error" role="alert">${escapeHtml(error)}</p>`).join("")}
<form method="post" action="/book/travellers">
${fieldsets}
<p><button>Continue to payment</button></p>
</form>`,
			`const PROFILE = ${scriptJson({ first: account.firstName, last: account.lastName, dob: dayMonthYear(account.dob), passport: account.passport })};${TRAVELLERS_SCRIPT}`,
		);
	};

	const saveTravellers = (session: string, draft: Draft, fields: Record<string, string>): SiteResponse => {
		const slots = travellerSlots(draft.search.adults, draft.search.children);
		const errors: string[] = [];
		const travellers: Traveller[] = [];
		slots.forEach((slot, i) => {
			const value = (field: (typeof TRAVELLER_FIELDS)[number]) => (fields[`t${i}_${field}`] ?? "").trim();
			const firstName = value("first");
			const lastName = value("last");
			const passport = value("passport").toUpperCase().replaceAll(" ", "");
			if (!/^[A-Za-z][A-Za-z' -]*$/.test(firstName) || !/^[A-Za-z][A-Za-z' -]*$/.test(lastName)) {
				errors.push(`${slot.label}: enter the first and last name in letters, as in the passport.`);
			}
			const dob = parseDayMonthYear(value("dob"));
			if (!dob) errors.push(`${slot.label}: write the date of birth as DD/MM/YYYY.`);
			else {
				const age = ageOn(dob, draft.search.depart);
				if (slot.type === "adult" && age < 12)
					errors.push(`${slot.label}: an adult is 12 or older on the day of travel.`);
				if (slot.type === "child" && (age < 2 || age > 11)) {
					errors.push(`${slot.label}: a child is 2 to 11 years old on the day of travel.`);
				}
			}
			if (!/^[A-Z]{2}\d{7}$/.test(passport))
				errors.push(`${slot.label}: a passport number is two letters and seven digits.`);
			travellers.push({ type: slot.type, firstName, lastName, dob: dob ?? "", passport });
		});
		if (errors.length > 0) return travellersPage(session, draft, errors, fields);
		draft.travellers = travellers;
		return redirect("/book/checkout");
	};

	const checkoutPage = (
		session: string,
		draft: Draft,
		legs: readonly { itinerary: Itinerary; family: FareFamily }[],
	) => {
		const travellers = draft.travellers ?? [];
		const { adults, children } = draft.search;
		const quote = quoteDraft(draft, legs);
		const names = legNames(legs.length);
		const flights = legs
			.map(
				({ itinerary, family }, i) => `<h3>${names[i]} · ${escapeHtml(longDate(itinerary.date))}</h3>
<ul>${itinerary.segments.map(segment => `<li>${segmentLine(segment)}</li>`).join("")}</ul>
<p>${escapeHtml(airlineByCode(itinerary.airline).name)} <strong>${escapeHtml(family.name)}</strong>: ${escapeHtml(fareSummary(family))}</p>`,
			)
			.join("");
		const lines = legs
			.flatMap(({ itinerary, family }, i) => {
				const adult = itinerary.fares[family.tier] as number;
				const rows = [
					`<tr><td>${names[i]} fare (${escapeHtml(family.name)}): ${adults} × ${money(adult)} per adult</td><td>${money(adult * adults)}</td></tr>`,
				];
				if (children > 0) {
					const child = childFareCents(adult, family);
					rows.push(
						`<tr><td>${names[i]} fare (${escapeHtml(family.name)}): ${children} × ${money(child)} per child</td><td>${money(child * children)}</td></tr>`,
					);
				}
				return rows;
			})
			.join("");
		return render(
			session,
			"Review and pay",
			`<h1>Review and pay</h1>
<section class="card"><h2>Flights</h2>${flights}</section>
<section class="card"><h2>Travellers</h2><ul>${travellers
				.map(
					traveller =>
						`<li>${escapeHtml(`${traveller.firstName} ${traveller.lastName}`)} (${traveller.type}), born ${escapeHtml(dayMonthYear(traveller.dob))}, passport ${escapeHtml(traveller.passport)}</li>`,
				)
				.join("")}</ul><a href="/book/travellers">Edit travellers</a></section>
<section class="card"><h2>Price</h2>
<table class="price-table">${lines}
<tr><td>Taxes and carrier fees: ${adults + children} × ${legs.length} × ${money(TAX_CENTS)}</td><td>${money(quote.taxesCents)}</td></tr>
${draft.insurance ? `<tr><td>Skyway Cover travel insurance: ${adults + children} × ${money(INSURANCE_CENTS)}</td><td>${money(quote.insuranceCents)}</td></tr>` : ""}
<tr class="total"><th>Total</th><th id="total">${money(quote.totalCents)}</th></tr>
</table>
<p><label class="inline"><input type="checkbox" id="insurance" autocomplete="off"${draft.insurance ? " checked" : ""}> Protect my trip with Skyway Cover travel insurance (${money(INSURANCE_CENTS)} per traveller)</label></p>
</section>
<section class="card"><h2>Payment</h2>
<p><label class="inline"><input type="checkbox" id="accept-rules" autocomplete="off"> I have read the fare rules and accept them</label></p>
<div id="payment" hidden><iframe id="paybox-frame" title="PayBox secure payment" data-src="${escapeHtml(payFrame(quote.totalCents))}"></iframe></div>
<p id="payment-status" role="status"></p>
</section>`,
			`${paymentConfig("/api/checkout/complete", {})}${PAYMENT_SCRIPT}${CHECKOUT_SCRIPT}`,
		);
	};

	const completeBooking = async (session: string, body: Readonly<Record<string, unknown>>): Promise<SiteResponse> => {
		const draft = drafts.get(session);
		const legs = draft ? draftLegs(draft) : null;
		if (!draft || !legs || !draft.travellers) {
			return json({ error: "Your booking has expired. Search for your flights again." }, { status: 409 });
		}
		const quote = quoteDraft(draft, legs);
		const charged = await chargeToken(
			String(body.token ?? ""),
			quote.totalCents,
			`Skyway booking, ${travellersText(draft.search.adults, draft.search.children)}`,
		);
		if ("error" in charged) return json({ error: charged.error }, { status: 402 });
		const booking: Booking = {
			ref: newBookingRef(world, rng),
			seeded: false,
			status: "confirmed",
			adults: draft.search.adults,
			children: draft.search.children,
			travellers: draft.travellers,
			legs: legs.map(({ itinerary, family }) => bookLeg(itinerary, family, draft.travellers?.length ?? 0)),
			insurance: draft.insurance,
			paidCents: quote.totalCents,
			chargeIds: [charged.id],
		};
		world.bookings.push(booking);
		drafts.delete(session);
		return json({ redirect: `/trips/${booking.ref}?booked=1` });
	};

	// -----------------------------------------------------------------------------------------
	// Trips

	const routeText = (booking: Booking) => {
		const first = booking.legs[0] as BookedLeg;
		return `${cityOf(first.from)} → ${cityOf(first.to)}${booking.legs.length === 2 ? " (round trip)" : ""}`;
	};

	const tripsPage = (session: string) =>
		render(
			session,
			"My trips",
			`<h1>My trips</h1>
<table><tr><th>Booking</th><th>Route</th><th>Dates</th><th>Travellers</th><th>Status</th></tr>${world.bookings
				.map(
					booking =>
						`<tr><td><a href="/trips/${booking.ref}">${booking.ref}</a></td><td>${escapeHtml(routeText(booking))}</td><td>${booking.legs
							.map(leg => escapeHtml(shortDate(leg.date)))
							.join(
								" – ",
							)}</td><td>${booking.travellers.length}</td><td>${booking.status === "confirmed" ? "Confirmed" : "Cancelled"}</td></tr>`,
				)
				.join("")}</table>`,
		);

	const tripPage = (session: string, booking: Booking, url: URL) => {
		const names = legNames(booking.legs.length);
		const notice = url.searchParams.get("booked")
			? `Booking ${booking.ref} is confirmed. You paid ${money(booking.paidCents)}.`
			: url.searchParams.get("changed")
				? "Your flight was changed."
				: "";
		const confirmed = booking.status === "confirmed";
		const legs = booking.legs
			.map((leg, i) => {
				const family = familyById(leg.familyId) as FareFamily;
				const segments = leg.segments
					.map(
						segment =>
							`<li>${segmentLine(segment)}<div class="muted">Seats: ${booking.travellers
								.map(
									(traveller, t) =>
										`${escapeHtml(`${traveller.firstName} ${traveller.lastName}`)} ${segment.seats[t] ?? "not chosen"}`,
								)
								.join(", ")}</div></li>`,
					)
					.join("");
				return `<section class="card"><h2>${names[i]} · ${escapeHtml(longDate(leg.date))}</h2>
<ul>${segments}</ul>
<p>${escapeHtml(airlineByCode(leg.airline).name)} <strong>${escapeHtml(family.name)}</strong>: ${escapeHtml(fareSummary(family))}. Paid ${money(leg.adultFareCents)} per adult${booking.children ? `, ${money(leg.childFareCents)} per child` : ""}.</p>
${confirmed ? `<p class="row"><a class="button secondary" href="/trips/${booking.ref}/seats?leg=${i}&amp;segment=0">Choose seats</a><a class="button secondary" href="/trips/${booking.ref}/change?leg=${i}">Change ${names[i]?.toLowerCase()} flight</a></p>` : ""}
</section>`;
			})
			.join("");
		return render(
			session,
			`Booking ${booking.ref}`,
			`${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<p><a href="/trips">← My trips</a></p>
<h1>Booking ${booking.ref}</h1>
<p class="muted">${confirmed ? "Confirmed" : "Cancelled"} · ${travellersText(booking.adults, booking.children)} · paid ${money(booking.paidCents)}${booking.insurance ? " · Skyway Cover insurance" : ""}</p>
${legs}
<section class="card"><h2>Travellers</h2><ul>${booking.travellers
				.map(
					traveller =>
						`<li>${escapeHtml(`${traveller.firstName} ${traveller.lastName}`)} (${traveller.type})</li>`,
				)
				.join("")}</ul></section>
${confirmed ? `<p><a class="danger" href="/trips/${booking.ref}/cancel">Cancel this booking</a></p>` : ""}`,
		);
	};

	const seatsPage = (session: string, booking: Booking, url: URL): SiteResponse => {
		const legIndex = Number(url.searchParams.get("leg") ?? "0");
		const segmentIndex = Number(url.searchParams.get("segment") ?? "0");
		const leg = booking.legs[legIndex];
		const segment = leg?.segments[segmentIndex];
		if (!leg || !segment) return text("No such flight in this booking", { status: 404 });
		if (booking.status !== "confirmed") return redirect(`/trips/${booking.ref}`);
		const family = familyById(leg.familyId) as FareFamily;
		const taken = takenSeats(world, flightKey(leg.date, segment.flightNo), booking.ref);
		const names = legNames(booking.legs.length);
		const tabs = booking.legs
			.flatMap((entry, li) =>
				entry.segments.map((part, si) => {
					const current = li === legIndex && si === segmentIndex;
					return `<a class="button${current ? "" : " secondary"}" href="/trips/${booking.ref}/seats?leg=${li}&amp;segment=${si}"${current ? ' aria-current="page"' : ""}>${names[li]}: ${escapeHtml(part.flightNo)} ${part.from} → ${part.to}</a>`;
				}),
			)
			.join("");
		const fees: Record<string, number> = {};
		const header = `<div class="cabin-row" aria-hidden="true"><span></span>${SEAT_LETTERS.map((letter, i) => {
			const position = seatPosition(letter);
			return `${i === 3 ? "<span></span>" : ""}<span class="col">${letter}<small>${position === "middle" ? "&nbsp;" : position === "window" ? "Window" : "Aisle"}</small></span>`;
		}).join("")}</div>`;
		const rows: string[] = [];
		for (let row = 1; row <= SEAT_ROWS; row++) {
			const seats = SEAT_LETTERS.map((letter, i) => {
				const seat = `${row}${letter}`;
				const fee = seatFeeCents(family, seat);
				if (fee > 0) fees[seat] = fee;
				const blocked = taken.has(seat);
				return `${i === 3 ? "<span></span>" : ""}<button type="button" class="seat${isLegroom(seat) ? " xl" : ""}${blocked ? " taken" : ""}" data-seat="${seat}" title="${seat}"${blocked ? " disabled" : ""}>${fee > 0 && !blocked ? `$${fee / 100}` : ""}</button>`;
			}).join("");
			const legroom = LEGROOM_ROWS.includes(row) ? `<small>${row === 1 ? "Front row" : "Exit row"}</small>` : "";
			rows.push(`<div class="cabin-row"><span class="rownum">Row ${row}${legroom}</span>${seats}</div>`);
		}
		return render(
			session,
			`Seats for ${segment.flightNo}`,
			`<p><a href="/trips/${booking.ref}">← Booking ${booking.ref}</a></p>
${url.searchParams.get("saved") ? '<p class="notice">Your seats are saved.</p>' : ""}
<h1>Choose seats</h1>
<p class="row">${tabs}</p>
<p>${segmentLine(segment)} · ${escapeHtml(shortDate(leg.date))} · ${escapeHtml(family.name)} fare: ${escapeHtml(seatsText(family))}</p>
<div class="who" role="radiogroup" aria-label="Choose a seat for">${booking.travellers
				.map(
					(traveller, i) =>
						`<label><input type="radio" name="who" value="${i}"${i === 0 ? " checked" : ""}> ${escapeHtml(`${traveller.firstName} ${traveller.lastName}`)}: <strong data-seat-of="${i}">${segment.seats[i] ?? "no seat"}</strong></label>`,
				)
				.join("")}</div>
<ul class="legend"><li><span class="seat"></span> Available</li><li><span class="seat xl"></span> Extra legroom</li><li><span class="seat taken"></span> Occupied</li><li><span class="seat mine"></span> Your party</li></ul>
<div class="cabin" aria-label="Seat map of ${escapeHtml(segment.flightNo)}">${header}${rows.join("")}</div>
<p>Seat fees: <strong id="seat-fee">$0.00</strong></p>
<p><button type="button" id="save-seats">Save seats</button></p>
<div id="payment" hidden><iframe id="paybox-frame" title="PayBox secure payment"></iframe></div>
<p id="payment-status" role="status"></p>`,
			`const SEATS = ${scriptJson({ leg: legIndex, segment: segmentIndex, current: segment.seats, fees })};${paymentConfig(`/api/trips/${booking.ref}/seats`, {})}${PAYMENT_SCRIPT}${SEATS_SCRIPT}`,
		);
	};

	const saveSeats = async (booking: Booking, body: Readonly<Record<string, unknown>>): Promise<SiteResponse> => {
		if (booking.status !== "confirmed") return json({ error: "This booking is cancelled." }, { status: 409 });
		const legIndex = Number(body.leg);
		const segmentIndex = Number(body.segment);
		const leg = booking.legs[legIndex];
		const segment = leg?.segments[segmentIndex];
		if (!leg || !segment) return json({ error: "No such flight in this booking." }, { status: 400 });
		const seats = body.seats;
		if (!Array.isArray(seats) || seats.length !== booking.travellers.length) {
			return json({ error: "Send one seat, or none, for each traveller." }, { status: 400 });
		}
		const chosen = seats.map(seat => (typeof seat === "string" && seat ? seat : null));
		const taken = takenSeats(world, flightKey(leg.date, segment.flightNo), booking.ref);
		for (const seat of chosen) {
			if (seat === null) continue;
			if (!parseSeat(seat)) return json({ error: `${seat} is not a seat on this aircraft.` }, { status: 400 });
			if (taken.has(seat)) return json({ error: `Seat ${seat} is taken.` }, { status: 409 });
		}
		const named = chosen.filter(seat => seat !== null);
		if (new Set(named).size !== named.length)
			return json({ error: "Two travellers cannot share a seat." }, { status: 400 });
		const family = familyById(leg.familyId) as FareFamily;
		const fee = chosen.reduce(
			(sum: number, seat, i) => sum + (seat && seat !== segment.seats[i] ? seatFeeCents(family, seat) : 0),
			0,
		);
		if (fee > 0) {
			const token = typeof body.token === "string" ? body.token : "";
			if (!token) return json({ needsPayment: true, amountCents: fee, frame: payFrame(fee) });
			const charged = await chargeToken(token, fee, `Seats on ${segment.flightNo}, booking ${booking.ref}`);
			if ("error" in charged) return json({ error: charged.error }, { status: 402 });
			booking.chargeIds.push(charged.id);
			booking.paidCents += fee;
		}
		segment.seats = chosen;
		return json({ redirect: `/trips/${booking.ref}/seats?leg=${legIndex}&segment=${segmentIndex}&saved=1` });
	};

	/** The dates a leg may move to: not before the leg ahead of it, not after the one behind it. */
	const changeBounds = (booking: Booking, legIndex: number) => {
		const before = booking.legs[legIndex - 1];
		const after = booking.legs[legIndex + 1];
		return {
			min: before && before.date > world.today ? before.date : world.today,
			max: after ? after.date : lastDay,
		};
	};

	const changeTarget = (
		booking: Booking,
		legIndex: number,
		itineraryId: string,
	): { itinerary: Itinerary; quote: ChangeQuote } | string => {
		if (booking.status !== "confirmed") return "This booking is cancelled.";
		const leg = booking.legs[legIndex];
		if (!leg) return "No such flight in this booking.";
		const itinerary = findItinerary(world, itineraryId);
		if (
			!itinerary ||
			itinerary.from !== leg.from ||
			itinerary.to !== leg.to ||
			itinerary.airline !== leg.airline ||
			itinerary.id === leg.itineraryId
		) {
			return "That flight cannot replace this one.";
		}
		const bounds = changeBounds(booking, legIndex);
		if (itinerary.date < bounds.min || itinerary.date > bounds.max)
			return "Your flights would be out of order on that date.";
		const quote = quoteChange(booking, legIndex, itinerary);
		return quote ? { itinerary, quote } : "This fare cannot be changed.";
	};

	const changePage = (session: string, booking: Booking, url: URL): SiteResponse => {
		const legIndex = Number(url.searchParams.get("leg") ?? "0");
		const leg = booking.legs[legIndex];
		if (!leg) return text("No such flight in this booking", { status: 404 });
		if (booking.status !== "confirmed") return redirect(`/trips/${booking.ref}`);
		const family = familyById(leg.familyId) as FareFamily;
		const airline = airlineByCode(leg.airline);
		const name = (legNames(booking.legs.length)[legIndex] ?? "Flight").toLowerCase();
		const current = `<div class="card"><strong>Your ${name} flight:</strong> ${escapeHtml(shortDate(leg.date))} · ${leg.segments.map(segment => segmentLine(segment)).join("; ")}</div>`;
		if (family.changeFeeCents === null) {
			return render(
				session,
				"Change flight",
				`<h1>Change your ${name} flight</h1>${current}<p class="card">Your ${escapeHtml(family.name)} fare cannot be changed.</p>`,
			);
		}
		const bounds = changeBounds(booking, legIndex);
		const date = url.searchParams.get("date") ?? "";
		let list = "";
		if (date) {
			if (!isIsoDate(date) || date < bounds.min || date > bounds.max) {
				list = `<p class="error">Choose a date from ${escapeHtml(longDate(bounds.min))} to ${escapeHtml(longDate(bounds.max))}.</p>`;
			} else {
				const options = itinerariesOn(world, leg.from, leg.to, date)
					.filter(itinerary => itinerary.airline === leg.airline && itinerary.id !== leg.itineraryId)
					.sort((a, b) => departOf(a) - departOf(b));
				list =
					options.length === 0
						? `<p class="card">${escapeHtml(airline.name)} has no other flight on that date.</p>`
						: `<h2>${escapeHtml(airline.name)} flights on ${escapeHtml(longDate(date))}</h2>${options
								.map(
									itinerary => `<div class="card"><div class="flight-main">
<div class="times"><strong>${clock(departOf(itinerary))}</strong> – <strong>${clock(arriveOf(itinerary))}</strong>${arriveOf(itinerary) >= 1440 ? " <sup>+1</sup>" : ""}</div>
<div>${itinerary.segments.map(segment => escapeHtml(segment.flightNo)).join(" · ")}</div>
<div>${durationText(arriveOf(itinerary) - departOf(itinerary))}<div class="muted">${
										stopsOf(itinerary) === 0
											? "Nonstop"
											: `${stopsOf(itinerary)} stop${stopsOf(itinerary) > 1 ? "s" : ""} (${layoversOf(
													itinerary,
												)
													.map(layover => layover.airport)
													.join(", ")})`
									}</div></div>
<div class="price">from <strong>${money(itinerary.fares[0] as number)}</strong><div class="muted">per adult</div></div>
<a class="button" href="/trips/${booking.ref}/change/review?leg=${legIndex}&amp;itinerary=${encodeURIComponent(itinerary.id)}">Select</a>
</div></div>`,
								)
								.join("")}`;
			}
		}
		return render(
			session,
			"Change flight",
			`<p><a href="/trips/${booking.ref}">← Booking ${booking.ref}</a></p>
<h1>Change your ${name} flight</h1>
${current}
<p>You can move to another ${escapeHtml(airline.name)} flight on the same route. You keep your ${escapeHtml(family.name)} fare, and you pay the change fee of ${money(family.changeFeeCents)} per traveller plus any rise in the ${escapeHtml(family.name)} fare over what you paid. A lower fare is not refunded.</p>
<form method="get" action="/trips/${booking.ref}/change" class="card row">
<input type="hidden" name="leg" value="${legIndex}">
${datePicker("date", "New date", bounds.min, bounds.max, isIsoDate(date) ? date : "")}
<button>Find flights</button>
</form>
${list}`,
			DATE_PICKER_SCRIPT,
		);
	};

	const reviewPage = (session: string, booking: Booking, url: URL): SiteResponse => {
		const legIndex = Number(url.searchParams.get("leg") ?? "0");
		const target = changeTarget(booking, legIndex, url.searchParams.get("itinerary") ?? "");
		if (typeof target === "string")
			return render(session, "Change flight", `<p class="error">${escapeHtml(target)}</p>`);
		const leg = booking.legs[legIndex] as BookedLeg;
		const family = familyById(leg.familyId) as FareFamily;
		const { itinerary, quote } = target;
		const travellers = booking.adults + booking.children;
		const body = { leg: legIndex, itinerary: itinerary.id };
		const payment =
			quote.totalCents > 0
				? `<p>Pay the change below.</p><div id="payment"><iframe id="paybox-frame" title="PayBox secure payment" src="${escapeHtml(payFrame(quote.totalCents))}"></iframe></div>`
				: '<p><button type="button" id="confirm-free">Confirm change</button></p>';
		return render(
			session,
			"Review your change",
			`<p><a href="/trips/${booking.ref}/change?leg=${legIndex}&amp;date=${itinerary.date}">← Other flights</a></p>
<h1>Review your change</h1>
<div class="card"><strong>From:</strong> ${escapeHtml(shortDate(leg.date))} · ${leg.segments.map(segment => segmentLine(segment)).join("; ")}<br>
<strong>To:</strong> ${escapeHtml(shortDate(itinerary.date))} · ${itinerary.segments.map(segment => segmentLine(segment)).join("; ")}</div>
<table class="price-table">
<tr><td>Change fee: ${travellers} × ${money(family.changeFeeCents ?? 0)}</td><td>${money(quote.feeCents)}</td></tr>
<tr><td>${escapeHtml(family.name)} fare on the new flight: ${money(quote.newAdultCents)} per adult (you paid ${money(leg.adultFareCents)})${booking.children ? `, ${money(quote.newChildCents)} per child (you paid ${money(leg.childFareCents)})` : ""}</td><td></td></tr>
<tr><td>Fare difference</td><td>${money(quote.differenceCents)}</td></tr>
<tr class="total"><th>Total to pay</th><th>${money(quote.totalCents)}</th></tr>
</table>
<p class="muted">Seats chosen on the current flight are released when the change is made.</p>
${payment}
<p id="payment-status" role="status"></p>`,
			`${paymentConfig(`/api/trips/${booking.ref}/change`, body)}${quote.totalCents > 0 ? PAYMENT_SCRIPT : CONFIRM_FREE_SCRIPT}`,
		);
	};

	const makeChange = async (booking: Booking, body: Readonly<Record<string, unknown>>): Promise<SiteResponse> => {
		const legIndex = Number(body.leg);
		const target = changeTarget(booking, legIndex, String(body.itinerary ?? ""));
		if (typeof target === "string") return json({ error: target }, { status: 400 });
		const { itinerary, quote } = target;
		let chargeId: string | null = null;
		if (quote.totalCents > 0) {
			const token = typeof body.token === "string" ? body.token : "";
			if (!token) return json({ error: "Pay for the change in the payment form." }, { status: 402 });
			const charged = await chargeToken(token, quote.totalCents, `Flight change, booking ${booking.ref}`);
			if ("error" in charged) return json({ error: charged.error }, { status: 402 });
			chargeId = charged.id;
			booking.chargeIds.push(charged.id);
			booking.paidCents += quote.totalCents;
		}
		const old = booking.legs[legIndex] as BookedLeg;
		booking.legs[legIndex] = bookLeg(itinerary, familyById(old.familyId) as FareFamily, booking.travellers.length);
		changes.push({
			ref: booking.ref,
			leg: legIndex,
			fromItinerary: old.itineraryId,
			toItinerary: itinerary.id,
			feeCents: quote.feeCents,
			differenceCents: quote.differenceCents,
			chargeId,
		});
		return json({ redirect: `/trips/${booking.ref}?changed=1` });
	};

	const cancelPage = (session: string, booking: Booking) =>
		booking.status !== "confirmed"
			? redirect(`/trips/${booking.ref}`)
			: render(
					session,
					"Cancel booking",
					`<p><a href="/trips/${booking.ref}">← Booking ${booking.ref}</a></p>
<h1>Cancel booking ${booking.ref}?</h1>
<p>Cancelling refunds ${money(cancellationRefundCents(booking))} of the ${money(booking.paidCents)} you paid. A refundable fare returns everything; any other fare returns the taxes only.</p>
<form method="post" action="/trips/${booking.ref}/cancel"><button class="secondary">Cancel this booking</button> <a href="/trips/${booking.ref}">Keep my booking</a></form>`,
				);

	const accountPage = (session: string) => {
		const account = world.account;
		return render(
			session,
			"Profile",
			`<h1>Profile</h1><table style="max-width:480px">
<tr><th>Name</th><td>${escapeHtml(`${account.firstName} ${account.lastName}`)}</td></tr>
<tr><th>Email</th><td>${escapeHtml(account.email)}</td></tr>
<tr><th>Date of birth</th><td>${escapeHtml(dayMonthYear(account.dob))}</td></tr>
<tr><th>Passport</th><td>${escapeHtml(account.passport)}</td></tr>
</table>`,
		);
	};

	const signinPage = (session: string, next: string, error = "") =>
		render(
			session,
			"Sign in",
			`<div class="card" style="max-width:360px"><h1>Sign in</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/signin"><input type="hidden" name="next" value="${escapeHtml(next)}">
<label>Email <input name="email" type="email" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<p><button>Sign in</button></p></form></div>`,
		);

	// -----------------------------------------------------------------------------------------
	// Routing

	const route = async (request: SiteRequest, session: string): Promise<SiteResponse> => {
		const { method, url } = request;
		const pathname = url.pathname;
		const query = Object.fromEntries(url.searchParams);
		if (pathname === "/" && method === "GET") return home(session, query);
		if (pathname === "/consent" && method === "POST") {
			consented.add(session);
			return { status: 204 };
		}
		if (pathname === "/api/airports") return airportsApi(url);
		if (pathname === "/api/search") return searchApi(url);
		if (pathname === "/flights" && method === "GET") {
			const search = parseSearch(query, world.today);
			if (typeof search === "string") return home(session, query, search);
			return resultsPage(session, search, query.leg === "1" && search.trip === "round" ? 1 : 0);
		}
		if (pathname === "/book/select" && method === "POST") return selectFare(session, formFields(request));
		if (pathname === "/signin" && method === "GET")
			return signinPage(session, url.searchParams.get("next") ?? "/trips");
		if (pathname === "/signin" && method === "POST") {
			const fields = formFields(request);
			if (fields.email?.trim().toLowerCase() === world.account.email && fields.password === world.account.password) {
				signedIn.add(session);
				return redirect(fields.next?.startsWith("/") ? fields.next : "/trips");
			}
			failedSignins++;
			return signinPage(session, fields.next ?? "/trips", "That email and password do not match an account.");
		}
		if (pathname === "/signout") {
			signedIn.delete(session);
			return redirect("/");
		}
		if (!signedIn.has(session)) {
			if (pathname.startsWith("/api/")) return json({ error: "Sign in first." }, { status: 401 });
			return redirect(`/signin?next=${encodeURIComponent(`${pathname}${url.search}`)}`);
		}

		if (pathname === "/account") return accountPage(session);
		if (pathname.startsWith("/book/") || pathname.startsWith("/api/checkout/")) {
			const draft = drafts.get(session);
			const legs = draft ? draftLegs(draft) : null;
			if (pathname === "/api/checkout/complete" && method === "POST") {
				return completeBooking(session, fieldsOf(jsonBody(request)));
			}
			if (!draft || !legs) {
				return pathname.startsWith("/api/")
					? json({ error: "Choose your flights first." }, { status: 409 })
					: redirect("/");
			}
			if (pathname === "/book/travellers") {
				return method === "POST"
					? saveTravellers(session, draft, formFields(request))
					: travellersPage(session, draft);
			}
			if (!draft.travellers) return redirect("/book/travellers");
			if (pathname === "/book/checkout" && method === "GET") return checkoutPage(session, draft, legs);
			if (pathname === "/api/checkout/insurance" && method === "POST") {
				draft.insurance = fieldsOf(jsonBody(request)).on === true;
				return json({ insurance: draft.insurance, totalCents: quoteDraft(draft, legs).totalCents });
			}
			return text("Not found", { status: 404 });
		}
		if (pathname === "/trips") return tripsPage(session);
		const tripMatch = /^\/(api\/)?trips\/([A-Z0-9]{6})(\/seats|\/change|\/change\/review|\/cancel)?$/.exec(pathname);
		if (tripMatch) {
			const booking = findBooking(world, tripMatch[2] as string);
			if (!booking) return text("No such booking", { status: 404 });
			const api = tripMatch[1] !== undefined;
			const action = tripMatch[3] ?? "";
			if (api && method === "POST") {
				const body = fieldsOf(jsonBody(request));
				if (action === "/seats") return saveSeats(booking, body);
				if (action === "/change") return makeChange(booking, body);
				return json({ error: "Not found" }, { status: 404 });
			}
			if (api) return json({ error: "Not found" }, { status: 404 });
			if (action === "") return tripPage(session, booking, url);
			if (action === "/seats") return seatsPage(session, booking, url);
			if (action === "/change") return changePage(session, booking, url);
			if (action === "/change/review") return reviewPage(session, booking, url);
			if (action === "/cancel") {
				if (method === "POST" && booking.status === "confirmed") {
					booking.status = "cancelled";
					cancellations.push(booking.ref);
					return redirect(`/trips/${booking.ref}`);
				}
				return cancelPage(session, booking);
			}
		}
		return text("Not found", { status: 404 });
	};

	const site = await hostSite(async request => {
		const session = sessionOf(request);
		const response = await route(request, session.id);
		return session.fresh
			? { ...response, cookies: [...(response.cookies ?? []), { name: SESSION_COOKIE, value: session.id }] }
			: response;
	});
	origin = site.origin;

	const close = async () => {
		await site.close();
		await paybox.close();
	};

	return {
		origin: site.origin,
		payOrigin: paybox.origin,
		close,
		async finish() {
			await close();
			return {
				today: world.today,
				bookings: world.bookings,
				charges: paybox.charges,
				changes,
				cancellations,
				failedSignins,
			};
		},
	};
}
