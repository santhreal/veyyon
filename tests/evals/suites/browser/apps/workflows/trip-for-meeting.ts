/**
 * `workflow-trip-for-meeting`: one job carried across Parcel Mail, Skyway and Trellis.
 *
 * The mailbox holds an invitation to a meeting in person in another city and a later message that
 * moves it to another day and time. The agent books on Skyway the cheapest day trip that lands two
 * hours before the moved meeting starts and takes off an hour after it ends, pays with the card the
 * instruction gives, and adds a card for the trip to the Trellis board of the meeting's project,
 * titled with the city and the booking reference and due on the meeting's day.
 *
 * Each step needs what another application holds: the flights need the moved day and times from the
 * mail, and the card needs the project and the day from the mail and the reference from Skyway. The
 * decoys: a cheaper trip on the meeting's original day, a cheaper flight on the new day that fits
 * only the original times or lands too late, a cheaper connection too tight to make, a cheaper
 * return that leaves too soon, and last month's trip, whose card sits on the same board and whose
 * booking sits among the account's trips.
 *
 * The three worlds are set on the mailbox's day, so every date the agent meets agrees across them.
 */

import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerHasText, answerNamesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { FormClient } from "../../../../engine/kit/form-client";
import { Seeded, seedOf } from "../../../../engine/kit/seeded";
import {
	boardOf,
	type CardDetails,
	type CardState,
	COLUMNS,
	type ColumnId,
	columnCards,
	detailsOf,
	generateKanban,
	type KanbanWorld,
	MOBILE,
	PLATFORM,
	slashDate,
	stateOf,
	WEBSITE,
	weekdayDate,
} from "../kanban/data";
import { type KanbanSnapshot, startKanbanSite } from "../kanban/site";
import {
	addContact,
	addMessage,
	generateMail,
	type MailWorld,
	newPerson,
	PARTNER_DOMAINS,
	type Person,
	TODAY,
	timeOn,
} from "../mail/data";
import { type MailSnapshot, startMailSite } from "../mail/site";
import {
	AIRPORTS,
	accountTraveller,
	addDays,
	arriveOf,
	type Booking,
	bookLeg,
	cityOf,
	clock,
	daysBetween,
	departOf,
	fareFamily,
	generateTravel,
	type Itinerary,
	itinerariesOn,
	layoversOf,
	longRoutes,
	makeItinerary,
	newBookingRef,
	quoteTrip,
	setLayover,
	shiftFares,
	shiftItinerary,
	stopsOf,
	type Traveller,
	type TravelWorld,
} from "../travel/data";
import { cardLast4, fieldsOf, type TestCard, testCard } from "../travel/paybox";
import { startTravelSite, type TravelSnapshot } from "../travel/site";

const TASK_ID = "workflow-trip-for-meeting";

/** The outbound flight lands this long before the meeting starts, at the latest. */
const ARRIVAL_LEAD_MIN = 120;
/** The return flight takes off this long after the meeting ends, at the earliest. */
const RETURN_GAP_MIN = 60;
/** The shortest connection the instruction allows. */
const MIN_CONNECTION_MIN = 45;
/** How far the fare of the flight to book stands below every other flight that meets the rules. */
const PRICE_MARGIN_CENTS = 800;
/** A flight the planner moves leaves after 05:00 and lands by 23:45 of its own day. */
const EARLIEST_DEPARTURE_MIN = 300;
const LATEST_ARRIVAL_MIN = 1425;
/** The fare family of the lowest price on every itinerary. */
const CHEAPEST_TIER = 0;
const TRIP_COLUMN: ColumnId = "ready";
/** Draws a planner makes before it gives up; a draw fails when a day's flights cannot be bent. */
const MAX_DRAWS = 100;

/** Each project is a Trellis board, and every meeting topic names its board. */
const PROJECTS: readonly { readonly board: string; readonly topics: readonly string[] }[] = [
	{ board: PLATFORM, topics: ["Platform architecture review", "Platform capacity planning session"] },
	{ board: MOBILE, topics: ["Mobile App roadmap workshop", "Mobile App release planning day"] },
	{ board: WEBSITE, topics: ["Website redesign workshop", "Website content planning day"] },
];

/** The moved meeting's start, its length, and how far the move shifted its start, in minutes. */
const STARTS = [720, 750, 780, 810, 840];
const LENGTHS = [120, 150, 180];
const SHIFTS = [-90, -60, 60, 90];
/** The original start stays between 11:30 and 15:30, so a morning flight can still reach it. */
const ORIGINAL_START_RANGE = [690, 930] as const;

const STREETS = ["Harbour Street", "Mill Lane", "Station Road", "Quay Street", "Market Square", "Bridge Road"];

interface Slot {
	/** `YYYY-MM-DD`. */
	readonly date: string;
	/** Minutes after midnight. */
	readonly start: number;
	readonly end: number;
}

/** The boards a correct run leaves behind, the new card aside. */
interface BoardBaseline {
	/** Column order of every board. */
	readonly columns: Readonly<Record<string, Readonly<Record<ColumnId, readonly string[]>>>>;
	/** The details of every card present before the trial. */
	readonly cards: Readonly<Record<string, CardDetails>>;
}

interface TripExpected {
	/** The itineraries to book, out and back, and the fare family of each. */
	readonly outbound: string;
	readonly inbound: string;
	readonly families: readonly string[];
	readonly chargeCents: number;
	readonly last4: string;
	readonly traveller: Traveller;
	/** The meeting as the later message moved it, and as the invitation first gave it. */
	readonly meeting: Slot;
	readonly original: Slot;
	/** The city flown to, as Skyway names it. */
	readonly city: string;
	readonly board: string;
	readonly column: ColumnId;
	/** Last month's trip: its booking reference, on Skyway and on its Trellis card. */
	readonly pastRef: string;
	readonly baseline: BoardBaseline;
}

interface TripState {
	readonly mail: MailSnapshot;
	readonly travel: TravelSnapshot;
	readonly kanban: KanbanSnapshot;
	readonly expected: TripExpected;
}

interface TripPlan {
	readonly mail: MailWorld;
	readonly travel: TravelWorld;
	readonly kanban: KanbanWorld;
	readonly card: TestCard;
	/** Airport codes: where the account lives, and where the meeting is. */
	readonly home: string;
	readonly destination: string;
	readonly organizer: string;
	readonly expected: TripExpected;
}

// ---------------------------------------------------------------------------------------------
// Flights

function cheapestFare(itinerary: Itinerary): number {
	return itinerary.fares[CHEAPEST_TIER] as number;
}

/** Give every connection of an itinerary an unhurried layover. */
function easeConnections(rng: Seeded, itinerary: Itinerary): void {
	for (let index = 0; index < stopsOf(itinerary); index++) setLayover(itinerary, index, rng.pick([50, 60, 75, 90]));
}

/** Move an itinerary by `delta` minutes when it then leaves after 05:00 and lands by 23:45; whether it moved. */
function moveWithinDay(itinerary: Itinerary, delta: number): boolean {
	if (departOf(itinerary) + delta < EARLIEST_DEPARTURE_MIN || arriveOf(itinerary) + delta > LATEST_ARRIVAL_MIN) {
		return false;
	}
	shiftItinerary(itinerary, delta);
	return true;
}

/** The time rule of one leg, with the instruction's connection rule. */
interface LegRule {
	readonly qualifies: (itinerary: Itinerary) => boolean;
	/** Place an itinerary `minutes` inside the rule's bound, or outside it for a negative `minutes`. */
	readonly place: (itinerary: Itinerary, minutes: number) => boolean;
}

function landsBy(deadline: number): LegRule {
	return {
		qualifies: itinerary =>
			arriveOf(itinerary) <= deadline &&
			layoversOf(itinerary).every(layover => layover.minutes >= MIN_CONNECTION_MIN),
		place: (itinerary, minutes) => moveWithinDay(itinerary, deadline - minutes - arriveOf(itinerary)),
	};
}

function leavesAfter(earliest: number): LegRule {
	return {
		qualifies: itinerary =>
			departOf(itinerary) >= earliest &&
			layoversOf(itinerary).every(layover => layover.minutes >= MIN_CONNECTION_MIN),
		place: (itinerary, minutes) => moveWithinDay(itinerary, earliest + minutes - departOf(itinerary)),
	};
}

interface Route {
	readonly from: string;
	readonly to: string;
	readonly date: string;
}

/** The first itinerary of `pool` that `fit` places, taken out of the pool. */
function takeFitting(pool: Itinerary[], fit: (itinerary: Itinerary) => boolean): Itinerary | undefined {
	const index = pool.findIndex(fit);
	return index === -1 ? undefined : pool.splice(index, 1)[0];
}

/** A way to fly with at most one stop and easy connections, placed 5 to 45 minutes inside `rule`. */
function easilyInside(rng: Seeded, rule: LegRule): (itinerary: Itinerary) => boolean {
	return itinerary => {
		if (stopsOf(itinerary) > 1) return false;
		easeConnections(rng, itinerary);
		return rule.place(itinerary, 5 * rng.int(1, 9));
	};
}

/**
 * Make one itinerary of the day the cheapest that meets `rule`, and plant two cheaper ones that
 * miss it: one with easy connections that falls outside the rule by 10 to `outsideBy` minutes, and
 * one with a connection too tight to make. Null when the day's itineraries cannot be placed so.
 */
function bendLeg(world: TravelWorld, rng: Seeded, route: Route, rule: LegRule, outsideBy: number): Itinerary | null {
	const day = itinerariesOn(world, route.from, route.to, route.date);
	const pool = rng.shuffle(day);
	const target = takeFitting(pool, easilyInside(rng, rule));
	const outside = takeFitting(pool, itinerary => {
		easeConnections(rng, itinerary);
		return rule.place(itinerary, -5 * rng.int(2, outsideBy / 5));
	});
	const tightFit = (itinerary: Itinerary) => {
		if (stopsOf(itinerary) === 0) return false;
		easeConnections(rng, itinerary);
		setLayover(itinerary, 0, rng.pick([25, 30, 35, 40]));
		return rule.place(itinerary, 5 * rng.int(2, 18));
	};
	let tight = takeFitting(pool, tightFit);
	if (!tight) {
		const created = makeItinerary(world, rng, { ...route, stops: 1 });
		if (tightFit(created)) {
			day.push(created);
			tight = created;
		}
	}
	if (!target || !outside || !tight) return null;
	const price = rng.int(140, 300) * 100;
	shiftFares(target, CHEAPEST_TIER, price);
	for (const decoy of [outside, tight]) shiftFares(decoy, CHEAPEST_TIER, price - rng.int(12, 60) * 100);
	for (const other of day) {
		if (other !== target && rule.qualifies(other) && cheapestFare(other) < price + PRICE_MARGIN_CENTS) {
			shiftFares(other, CHEAPEST_TIER, price + rng.int(8, 80) * 100);
		}
	}
	const ranked = day.filter(rule.qualifies).sort((a, b) => cheapestFare(a) - cheapestFare(b));
	const runnerUp = ranked[1] ? cheapestFare(ranked[1]) : Number.POSITIVE_INFINITY;
	if (ranked[0] !== target || runnerUp < price + PRICE_MARGIN_CENTS) return null;
	if ([outside, tight].some(decoy => rule.qualifies(decoy) || cheapestFare(decoy) >= price)) return null;
	return target;
}

/** Make one itinerary of the day meet `rule` for less than `below`: the original day's tempting trip. */
function plantOriginal(world: TravelWorld, rng: Seeded, route: Route, rule: LegRule, below: number): boolean {
	const chosen = takeFitting(
		rng.shuffle(itinerariesOn(world, route.from, route.to, route.date)),
		easilyInside(rng, rule),
	);
	if (!chosen) return false;
	shiftFares(chosen, CHEAPEST_TIER, below - rng.int(15, 60) * 100);
	return true;
}

function nonstopOn(world: TravelWorld, rng: Seeded, route: Route): Itinerary {
	const day = itinerariesOn(world, route.from, route.to, route.date);
	const found = day.filter(itinerary => stopsOf(itinerary) === 0);
	if (found.length > 0) return rng.pick(found);
	const created = makeItinerary(world, rng, { ...route, stops: 0 });
	day.push(created);
	return created;
}

/** A booking made before the trial, paid in full. */
function seedBooking(
	world: TravelWorld,
	rng: Seeded,
	itineraries: readonly Itinerary[],
	traveller: Traveller,
): Booking {
	const tier = rng.int(0, 2);
	const legs = itineraries.map(itinerary => ({ itinerary, family: fareFamily(itinerary.airline, tier) }));
	const quote = quoteTrip(
		legs.map(leg => ({ family: leg.family, adultCents: leg.itinerary.fares[tier] as number })),
		1,
		0,
		false,
	);
	const booking: Booking = {
		ref: newBookingRef(world, rng),
		seeded: true,
		status: "confirmed",
		adults: 1,
		children: 0,
		travellers: [traveller],
		legs: legs.map(leg => bookLeg(leg.itinerary, leg.family, 1)),
		insurance: false,
		paidCents: quote.totalCents,
		chargeIds: [],
	};
	world.bookings.push(booking);
	return booking;
}

// ---------------------------------------------------------------------------------------------
// Planning

function weekday(date: string): boolean {
	const day = new Date(`${date}T12:00:00Z`).getUTCDay();
	return day !== 0 && day !== 6;
}

/** Kanban's world moved onto the mailbox's day: every date on a card keeps its distance from today. */
function onMailboxDay(generated: KanbanWorld): KanbanWorld {
	const delta = daysBetween(generated.today, TODAY);
	for (const card of generated.cards) {
		if (card.due) card.due = addDays(card.due, delta);
		if (card.completed) card.completed = addDays(card.completed, delta);
		card.comments = card.comments.map(comment => ({ ...comment, date: addDays(comment.date, delta) }));
	}
	return { ...generated, today: TODAY };
}

/** The meeting's two slots, on weekdays: the one the invitation gave, and the one it moved to. */
function drawSlots(rng: Seeded): { readonly original: Slot; readonly moved: Slot } {
	const length = rng.pick(LENGTHS);
	const { start, shift } = rng.pick(
		STARTS.flatMap(at => SHIFTS.map(by => ({ start: at, shift: by }))).filter(
			option =>
				option.start - option.shift >= ORIGINAL_START_RANGE[0] &&
				option.start - option.shift <= ORIGINAL_START_RANGE[1],
		),
	);
	const originalDate = rng.pick(Array.from({ length: 17 }, (_, index) => addDays(TODAY, 12 + index)).filter(weekday));
	const movedDate = rng.pick(
		[-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6]
			.map(days => addDays(originalDate, days))
			.filter(date => weekday(date) && daysBetween(TODAY, date) >= 7),
	);
	return {
		original: { date: originalDate, start: start - shift, end: start - shift + length },
		moved: { date: movedDate, start, end: start + length },
	};
}

/** One draw of the whole scenario; null when its flights cannot be bent, so the planner draws again. */
function drawPlan(seed: number, draw: number): TripPlan | null {
	const stream = (name: string) => new Seeded(seedOf(`${TASK_ID}|${name}|${seed}|${draw}`));
	const rng = stream("plan");
	const mail = generateMail(stream("mail"));
	const generatedTravel = generateTravel(stream("travel"));
	const kanban = onMailboxDay(generateKanban(stream("kanban")));
	const [firstName = "", lastName = ""] = mail.account.name.split(" ");
	const travel: TravelWorld = {
		...generatedTravel,
		today: TODAY,
		account: { ...generatedTravel.account, firstName, lastName, email: mail.account.email },
	};
	const { original, moved } = drawSlots(rng);
	const [home, destination] = rng.pick(longRoutes());

	// The new day: the trip to book and its decoys. A decoy that misses the new times fits the
	// original ones when the move went its way: an earlier start for the outbound flight, a later
	// end for the return.
	const shift = moved.start - original.start;
	const outbound = bendLeg(
		travel,
		rng,
		{ from: home, to: destination, date: moved.date },
		landsBy(moved.start - ARRIVAL_LEAD_MIN),
		shift < 0 ? -shift : 60,
	);
	const inbound = bendLeg(
		travel,
		rng,
		{ from: destination, to: home, date: moved.date },
		leavesAfter(moved.end + RETURN_GAP_MIN),
		shift > 0 ? shift : 60,
	);
	if (!outbound || !inbound) return null;
	// The original day: a cheaper trip that meets the invitation's first times.
	const originalOut = plantOriginal(
		travel,
		rng,
		{ from: home, to: destination, date: original.date },
		landsBy(original.start - ARRIVAL_LEAD_MIN),
		cheapestFare(outbound),
	);
	const originalBack = plantOriginal(
		travel,
		rng,
		{ from: destination, to: home, date: original.date },
		leavesAfter(original.end + RETURN_GAP_MIN),
		cheapestFare(inbound),
	);
	if (!originalOut || !originalBack) return null;

	// Last month's trip, and one later trip, already in the account.
	const traveller = accountTraveller(travel.account);
	const pastCity = rng.pick(
		AIRPORTS.filter(airport => !airport.hub && airport.code !== home && airport.code !== destination),
	).code;
	const pastDate = addDays(TODAY, -rng.int(22, 40));
	const past = seedBooking(
		travel,
		rng,
		[
			nonstopOn(travel, rng, { from: home, to: pastCity, date: pastDate }),
			nonstopOn(travel, rng, { from: pastCity, to: home, date: addDays(pastDate, 1) }),
		],
		traveller,
	);
	const [laterFrom, laterTo] = rng.pick(longRoutes().filter(route => !route.includes(destination)));
	const laterDate = addDays(TODAY, rng.int(40, 80));
	seedBooking(
		travel,
		rng,
		[
			nonstopOn(travel, rng, { from: laterFrom, to: laterTo, date: laterDate }),
			nonstopOn(travel, rng, { from: laterTo, to: laterFrom, date: addDays(laterDate, rng.int(2, 6)) }),
		],
		traveller,
	);

	// The project's board, holding last month's trip card, finished.
	const project = rng.pick(PROJECTS);
	const topic = rng.pick(project.topics);
	const board = boardOf(kanban, project.board);
	const pastCard = rng.pick(columnCards(kanban, board.id, "done"));
	pastCard.title = `Trip to ${cityOf(pastCity)}, booking ${past.ref}`;
	pastCard.labels = [];
	pastCard.assignee = null;
	pastCard.checklist = [];
	pastCard.due = pastDate;
	pastCard.completed = addDays(pastDate, 2);

	// The invitation, and the later message in its conversation that moves the meeting.
	const domain = rng.pick(PARTNER_DOMAINS);
	const company = (domain.split(".")[0] ?? domain)
		.split("-")
		.map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join(" ");
	const organizer = addContact(mail, newPerson(mail, rng, domain));
	const city = cityOf(destination);
	const subject = `Invitation: ${topic} in ${city}`;
	const me: Person = { name: mail.account.name, email: mail.account.email };
	const invitation = addMessage(mail, rng, {
		from: organizer,
		to: [me],
		subject,
		body: `Hi ${firstName},\n\nWe would like you to join us in person for the ${topic} at our office in ${city}, ${rng.int(2, 90)} ${rng.pick(STREETS)}, on ${weekdayDate(original.date)}, from ${clock(original.start)} to ${clock(original.end)}. Lunch is provided.\n\nPlease arrange your own travel; the room details follow the week before.\n\nBest,\n${organizer.name}\n${company}`,
		date: timeOn(rng, addDays(TODAY, -rng.int(9, 16)), 8, 17),
		folder: "inbox",
	});
	addMessage(mail, rng, {
		from: organizer,
		to: [me],
		subject: `Re: ${subject}`,
		threadId: invitation.threadId,
		body: `Hi ${firstName},\n\nA change of plan: we have had to move the ${topic}. It now takes place on ${weekdayDate(moved.date)}, from ${clock(moved.start)} to ${clock(moved.end)}, at the same office in ${city}. Everything else stays as planned.\n\nSorry for the shuffle,\n${organizer.name.split(" ")[0] ?? organizer.name}`,
		date: timeOn(rng, addDays(TODAY, -rng.int(1, 5)), 8, 17),
		folder: "inbox",
		read: false,
	});

	const card = testCard(rng, TODAY, `${firstName} ${lastName}`, travel.savedCardLast4);
	const legs = [outbound, inbound].map(itinerary => ({
		family: fareFamily(itinerary.airline, CHEAPEST_TIER),
		adultCents: cheapestFare(itinerary),
	}));
	const state = stateOf(kanban);
	return {
		mail,
		travel,
		kanban,
		card,
		home,
		destination,
		organizer: organizer.name,
		expected: {
			outbound: outbound.id,
			inbound: inbound.id,
			families: legs.map(leg => leg.family.id),
			chargeCents: quoteTrip(legs, 1, 0, false).totalCents,
			last4: cardLast4(card),
			traveller,
			meeting: moved,
			original,
			city,
			board: board.id,
			column: TRIP_COLUMN,
			pastRef: past.ref,
			baseline: {
				columns: Object.fromEntries(state.boards.map(entry => [entry.id, entry.columns])),
				cards: Object.fromEntries(
					state.cards.filter(entry => entry.seeded).map(entry => [entry.id, detailsOf(entry)]),
				),
			},
		},
	};
}

function planTrip(seed: number): TripPlan {
	for (let draw = 0; draw < MAX_DRAWS; draw++) {
		const plan = drawPlan(seed, draw);
		if (plan) return plan;
	}
	throw new Error(`no draw of seed ${seed} gave a trip whose flights could be bent`);
}

// ---------------------------------------------------------------------------------------------
// Solving

/** A JSON post whose answer the solution needs; it throws on anything but a 200 with a JSON body. */
async function postFor(client: FormClient, path: string, body: unknown): Promise<Readonly<Record<string, unknown>>> {
	const response = await client.postJson(path, body);
	if (response.status !== 200) throw new Error(`POST ${path} answered ${response.status}: ${response.body}`);
	return fieldsOf(JSON.parse(response.body));
}

// ---------------------------------------------------------------------------------------------
// Grading

function newBookings(state: TripState): readonly Booking[] {
	return state.travel.bookings.filter(booking => !booking.seeded);
}

function onlyBooking(state: TripState): Booking | undefined {
	const placed = newBookings(state);
	return placed.length === 1 ? placed[0] : undefined;
}

function createdCards(state: TripState): readonly CardState[] {
	return state.kanban.cards.filter(card => !card.seeded);
}

function onlyCard(state: TripState): CardState | undefined {
	const created = createdCards(state);
	return created.length === 1 ? created[0] : undefined;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Every card present before the trial holds the details it had, and every column its cards in order. */
function boardKept(state: TripState): boolean {
	const { baseline } = state.expected;
	const seeded = new Set(state.kanban.cards.filter(card => card.seeded).map(card => card.id));
	const cardsKept = Object.entries(baseline.cards).every(([id, expected]) => {
		const card = state.kanban.cards.find(entry => entry.id === id);
		return card !== undefined && JSON.stringify(detailsOf(card)) === JSON.stringify(expected);
	});
	const columnsKept = Object.entries(baseline.columns).every(([boardId, columns]) => {
		const now = state.kanban.boards.find(entry => entry.id === boardId)?.columns;
		return COLUMNS.every(({ id }) =>
			sameList(
				now?.[id].filter(card => seeded.has(card)),
				columns[id],
			),
		);
	});
	return cardsKept && columnsKept;
}

const CHECKS: readonly Check<TripState>[] = [
	{
		id: "one-booking",
		description: "made exactly one new booking on Skyway",
		pass: state => newBookings(state).length === 1,
	},
	{
		id: "outbound-flight",
		description:
			"the outbound flight is the cheapest on the moved meeting's day that lands two hours before it starts, with workable connections",
		pass: state => onlyBooking(state)?.legs[0]?.itineraryId === state.expected.outbound,
	},
	{
		id: "return-flight",
		description:
			"the return flight is the cheapest that day that takes off an hour after the moved meeting ends, with workable connections",
		pass: state => {
			const booking = onlyBooking(state);
			return booking?.legs.length === 2 && booking.legs[1]?.itineraryId === state.expected.inbound;
		},
	},
	{
		id: "fare-total",
		description: "both flights are on their lowest fare, without the insurance: the trip's lowest total",
		pass: state => {
			const booking = onlyBooking(state);
			return (
				booking !== undefined &&
				sameList(
					booking.legs.map(leg => leg.familyId),
					state.expected.families,
				) &&
				!booking.insurance &&
				booking.paidCents === state.expected.chargeCents
			);
		},
	},
	{
		id: "traveller",
		description: "the one traveller is the account holder, as in the profile",
		pass: state => {
			const booking = onlyBooking(state);
			const key = (traveller: Traveller) =>
				[
					traveller.type,
					normalizeText(traveller.firstName),
					normalizeText(traveller.lastName),
					traveller.dob,
					traveller.passport.toUpperCase(),
				].join("|");
			return (
				booking?.adults === 1 &&
				booking.children === 0 &&
				sameList(booking.travellers.map(key), [key(state.expected.traveller)])
			);
		},
	},
	{
		id: "one-charge",
		description: "PayBox made one charge, of the trip's total, to the card given",
		pass: state => {
			const [charge, ...rest] = state.travel.charges;
			return (
				charge !== undefined &&
				rest.length === 0 &&
				charge.amountCents === state.expected.chargeCents &&
				charge.last4 === state.expected.last4 &&
				!charge.savedCard
			);
		},
	},
	{
		id: "no-original-date",
		description: "booked no flight on the day the invitation first gave",
		pass: state =>
			newBookings(state).every(booking => booking.legs.every(leg => leg.date !== state.expected.original.date)),
	},
	{
		id: "one-card",
		description: "created exactly one card on Trellis",
		pass: state => createdCards(state).length === 1,
	},
	{
		id: "card-place",
		description: "the card is in Ready on the board of the meeting's project, not archived",
		pass: state => {
			const card = onlyCard(state);
			return card?.boardId === state.expected.board && card.column === state.expected.column && !card.archived;
		},
	},
	{
		id: "card-title",
		description: "the card's title names the city flown to and the new booking's reference, not last month's",
		pass: state => {
			const card = onlyCard(state);
			const booking = onlyBooking(state);
			return (
				card !== undefined &&
				booking !== undefined &&
				answerHasText(card.title, state.expected.city) &&
				answerHasText(card.title, booking.ref) &&
				!answerHasText(card.title, state.expected.pastRef)
			);
		},
	},
	{
		id: "card-due",
		description: "the card is due on the moved meeting's day",
		pass: state => onlyCard(state)?.due === state.expected.meeting.date,
	},
	{
		id: "board-unchanged",
		description: "no other card was edited, moved or archived, last month's trip card included",
		pass: boardKept,
	},
	{
		id: "no-mail-sent",
		description: "sent no email",
		pass: state => state.mail.sent.length === 0,
	},
	{
		id: "answer-reference",
		description: "the reply states the new booking's reference and no other trip's",
		pass: (state, answer) => {
			const booking = onlyBooking(state);
			return (
				booking !== undefined &&
				answerNamesOnly(
					answer,
					booking.ref,
					state.travel.bookings.map(entry => entry.ref),
				)
			);
		},
	},
];

// ---------------------------------------------------------------------------------------------
// The task

export const tripForMeetingTask: KitTask = kitTask<TripState>({
	id: TASK_ID,
	title: "Book the cheapest day trip to a moved meeting and track it on the project's board",
	capabilities: [
		"workflow",
		"multi-tab",
		"reasoning",
		"reading",
		"search-filter",
		"date-picker",
		"iframes",
		"forms",
		"overlays",
		"multi-page",
		"auth",
	],
	difficulty: "expert",
	timeBudgetSec: 1200,
	async start({ seed }) {
		const plan = planTrip(seed);
		const { expected, card } = plan;
		// A site that cannot start must not leave the ones started before it listening.
		const started: { close(): Promise<void> }[] = [];
		const { mailSite, travelSite, kanbanSite } = await (async () => {
			const mailSite = await startMailSite(plan.mail, seedOf(`${TASK_ID}|mail-site|${seed}`));
			started.push(mailSite);
			const travelSite = await startTravelSite(plan.travel, seedOf(`${TASK_ID}|travel-site|${seed}`));
			started.push(travelSite);
			const kanbanSite = await startKanbanSite(plan.kanban);
			started.push(kanbanSite);
			return { mailSite, travelSite, kanbanSite };
		})().catch(async (error: unknown) => {
			await Promise.all(started.map(site => site.close()));
			throw error;
		});
		const { email, name, password } = plan.mail.account;
		return {
			instruction: [
				`You are ${name}. This job takes three web applications:`,
				`- Parcel Mail, your webmail, at ${mailSite.origin}. Sign in with email ${email} and password ${password}.`,
				`- Skyway, a flight booking site, at ${travelSite.origin}. Sign in with email ${email} and password ${plan.travel.account.password}.`,
				`- Trellis, your team's kanban boards, at ${kanbanSite.origin}. It needs no sign-in.`,
				`${plan.organizer} has invited you by email to a meeting in person in another city. You live in ${cityOf(plan.home)} and fly from its airport.`,
				"Book a round trip on Skyway for yourself alone, as recorded in your Skyway profile, flying out and back on the day of the meeting. The outbound flight must land at least two hours before the meeting starts, the return flight must take off at least one hour after the meeting ends, and every connection must leave at least 45 minutes between flights. Of the trips that meet these conditions, book the one with the lowest total price, and buy nothing else.",
				`Pay with this card: number ${card.number}, expiry ${card.expiry}, security code ${card.cvc}, name on card ${card.name}.`,
				"Then, on Trellis, add a card for the trip to the Ready column of the board of the project the meeting is about. Its title must name the city you fly to and the booking reference, and its due date must be the day of the meeting. Change no other card.",
				"Send no email.",
				"Reply with the booking reference alone.",
			].join("\n"),
			solve: async () => {
				const travel = new FormClient(travelSite.origin);
				const signedIn = await travel.post("/signin", {
					email,
					password: plan.travel.account.password,
					next: "/trips",
				});
				if (!signedIn.url.endsWith("/trips"))
					throw new Error(`signing in to Skyway failed; it answered ${signedIn.url}`);
				const search = {
					trip: "round",
					from: plan.home,
					to: plan.destination,
					depart: expected.meeting.date,
					return: expected.meeting.date,
					adults: "1",
					children: "0",
				};
				for (const [leg, itinerary] of [expected.outbound, expected.inbound].entries()) {
					await travel.post("/book/select", {
						...search,
						leg: String(leg),
						itinerary,
						fare: expected.families[leg] ?? "",
					});
				}
				const { traveller } = expected;
				await travel.post("/book/travellers", {
					t0_first: traveller.firstName,
					t0_last: traveller.lastName,
					t0_dob: `${traveller.dob.slice(8, 10)}/${traveller.dob.slice(5, 7)}/${traveller.dob.slice(0, 4)}`,
					t0_passport: traveller.passport,
				});
				await postFor(travel, "/api/checkout/insurance", { on: false });
				// What PayBox's frame does: exchange the card for a token.
				const { token } = await postFor(new FormClient(travelSite.payOrigin), "/api/tokens", {
					number: card.number,
					expiry: card.expiry,
					cvc: card.cvc,
					name: card.name,
				});
				const { redirect } = await postFor(travel, "/api/checkout/complete", { token });
				const ref = typeof redirect === "string" ? /^\/trips\/([A-Z0-9]{6})/.exec(redirect)?.[1] : undefined;
				if (!ref) throw new Error(`the checkout made no booking; it sent the browser to ${String(redirect)}`);
				const kanban = new FormClient(kanbanSite.origin);
				const created = fieldsOf(
					(
						await postFor(kanban, `/api/boards/${expected.board}/cards`, {
							column: expected.column,
							title: `Trip to ${expected.city}, booking ${ref}`,
						})
					).card,
				);
				await postFor(kanban, `/api/cards/${String(created.id)}`, { due: slashDate(expected.meeting.date) });
				return ref;
			},
			finish: async () => {
				const [mail, travel, kanban] = await Promise.all([
					mailSite.finish(),
					travelSite.finish(),
					kanbanSite.finish(),
				]);
				return { mail, travel, kanban, expected };
			},
		};
	},
	checks: CHECKS,
});
