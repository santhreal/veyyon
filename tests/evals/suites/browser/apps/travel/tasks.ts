/**
 * Tasks performed against Skyway. Each plans its scenario on a freshly seeded world, bending fares,
 * times and seat maps so the answer is unique and the tempting wrong answers exist, then grades what
 * Skyway and PayBox recorded.
 */

import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerNamesOnly, answerStatesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { FormClient, type FormResponse } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	AIRLINES,
	accountTraveller,
	addDays,
	allSeats,
	arriveOf,
	type Booking,
	birthDate,
	bookLeg,
	CARRY_ON_TIER,
	cityOf,
	clock,
	departOf,
	fareFamily,
	flightKey,
	generateTravel,
	type Itinerary,
	isLegroom,
	itinerariesOn,
	LEGROOM_ROWS,
	layoversOf,
	longDate,
	longRoutes,
	makeItinerary,
	newBookingRef,
	quoteChange,
	quoteTrip,
	randomTraveller,
	SEAT_ROWS,
	setFare,
	setLayover,
	shiftFares,
	shiftItinerary,
	stopsOf,
	type Traveller,
	type TravelWorld,
	takenSeats,
	togetherOnTheAisle,
} from "./data";
import { cardLast4, fieldsOf, type TestCard, testCard } from "./paybox";
import { startTravelSite, type TravelSnapshot } from "./site";

interface Expected<T> {
	readonly expected: T;
}

type TravelState<T> = TravelSnapshot & Expected<T>;

function newBookings(state: TravelSnapshot): readonly Booking[] {
	return state.bookings.filter(booking => !booking.seeded);
}

function onlyNewBooking(state: TravelSnapshot): Booking | undefined {
	const placed = newBookings(state);
	return placed.length === 1 ? placed[0] : undefined;
}

function signIn(world: TravelWorld): string {
	return `Sign in with email ${world.account.email} and password ${world.account.password}.`;
}

function payWith(card: TestCard): string {
	return `Pay with this card: number ${card.number}, expiry ${card.expiry}, security code ${card.cvc}, name on card ${card.name}.`;
}

async function signedInClient(origin: string, world: TravelWorld): Promise<FormClient> {
	const client = new FormClient(origin);
	await client.post("/signin", { email: world.account.email, password: world.account.password, next: "/trips" });
	return client;
}

/** What the payment frame does: exchange the card for a PayBox token. */
async function payToken(payOrigin: string, card: TestCard): Promise<string> {
	const response = await new FormClient(payOrigin).postJson("/api/tokens", {
		number: card.number,
		expiry: card.expiry,
		cvc: card.cvc,
		name: card.name,
	});
	const token = fieldsOf(JSON.parse(response.body)).token;
	if (typeof token !== "string") throw new Error(`PayBox issued no token: ${response.body}`);
	return token;
}

/** The page a JSON endpoint sends the browser to next. */
function redirectOf(response: FormResponse): string {
	const target = fieldsOf(JSON.parse(response.body)).redirect;
	if (typeof target !== "string") throw new Error(`${response.url} answered ${response.status}: ${response.body}`);
	return target;
}

function bookingRefOf(response: FormResponse): string {
	const ref = /^\/trips\/([A-Z0-9]{6})/.exec(redirectOf(response))?.[1];
	if (!ref) throw new Error(`the checkout made no booking: ${response.body}`);
	return ref;
}

/** `DD/MM/YYYY`, the way the travellers form takes a date of birth. */
function dayMonthYear(date: string): string {
	return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

function travellerFields(travellers: readonly Traveller[]): Record<string, string> {
	const fields: Record<string, string> = {};
	travellers.forEach((traveller, i) => {
		fields[`t${i}_first`] = traveller.firstName;
		fields[`t${i}_last`] = traveller.lastName;
		fields[`t${i}_dob`] = dayMonthYear(traveller.dob);
		fields[`t${i}_passport`] = traveller.passport;
	});
	return fields;
}

function travellerKey(traveller: Traveller): string {
	return [
		traveller.type,
		normalizeText(traveller.firstName),
		normalizeText(traveller.lastName),
		traveller.dob,
		traveller.passport.toUpperCase(),
	].join("|");
}

function sameTravellers(a: readonly Traveller[], b: readonly Traveller[]): boolean {
	return JSON.stringify(a.map(travellerKey).sort()) === JSON.stringify(b.map(travellerKey).sort());
}

function travellerLine(traveller: Traveller): string {
	return `${traveller.firstName} ${traveller.lastName}, ${traveller.type}, born ${birthDate(traveller.dob)}, passport ${traveller.passport}`;
}

function nonstopOn(
	world: TravelWorld,
	rng: Seeded,
	from: string,
	to: string,
	date: string,
	airline?: string,
): Itinerary {
	const day = itinerariesOn(world, from, to, date);
	const found = day.filter(itinerary => stopsOf(itinerary) === 0 && (!airline || itinerary.airline === airline));
	if (found.length > 0) return rng.pick(found);
	const created = makeItinerary(world, rng, { from, to, date, stops: 0, airline });
	day.push(created);
	return created;
}

/** A booking made before the trial, paid in full, with no seats chosen. */
function seedBooking(
	world: TravelWorld,
	rng: Seeded,
	itineraries: readonly Itinerary[],
	tier: number,
	travellers: readonly Traveller[],
): Booking {
	const adults = travellers.filter(traveller => traveller.type === "adult").length;
	const children = travellers.length - adults;
	const legs = itineraries.map(itinerary =>
		bookLeg(itinerary, fareFamily(itinerary.airline, tier), travellers.length),
	);
	const quote = quoteTrip(
		itineraries.map(itinerary => ({
			family: fareFamily(itinerary.airline, tier),
			adultCents: itinerary.fares[tier] as number,
		})),
		adults,
		children,
		false,
	);
	const booking: Booking = {
		ref: newBookingRef(world, rng),
		seeded: true,
		status: "confirmed",
		adults,
		children,
		travellers,
		legs,
		insurance: false,
		paidCents: quote.totalCents,
		chargeIds: [],
	};
	world.bookings.push(booking);
	return booking;
}

/** Give every traveller a free standard seat on every flight of the booking. */
function assignSeats(world: TravelWorld, rng: Seeded, booking: Booking): void {
	for (const leg of booking.legs) {
		for (const segment of leg.segments) {
			const taken = takenSeats(world, flightKey(leg.date, segment.flightNo), booking.ref);
			const free = allSeats().filter(seat => !taken.has(seat) && !isLegroom(seat));
			segment.seats = rng.sample(free, booking.travellers.length);
		}
	}
}

/** Two upcoming trips on other routes, so the trips list holds more than the task's booking. */
function addOtherTrips(world: TravelWorld, rng: Seeded): void {
	for (let i = 0; i < 2; i++) {
		const [from, to] = rng.pick(longRoutes());
		const out = addDays(world.today, rng.int(8, 90));
		const itineraries = [nonstopOn(world, rng, from, to, out)];
		if (rng.next() < 0.6) itineraries.push(nonstopOn(world, rng, to, from, addDays(out, rng.int(2, 10))));
		const travellers = [accountTraveller(world.account)];
		if (rng.next() < 0.5) travellers.push(randomTraveller(rng, "adult", world.today));
		const booking = seedBooking(world, rng, itineraries, rng.int(0, 2), travellers);
		if (rng.next() < 0.5) assignSeats(world, rng, booking);
	}
}

function newWorld(seed: number): { world: TravelWorld; rng: Seeded } {
	const rng = new Seeded(seed);
	const world = generateTravel(rng);
	addOtherTrips(world, rng);
	return { world, rng };
}

const ONE_BOOKING: Check<TravelSnapshot> = {
	id: "one-booking",
	description: "made exactly one new booking",
	pass: state => newBookings(state).length === 1,
};

const NO_NEW_BOOKING: Check<TravelSnapshot> = {
	id: "no-new-booking",
	description: "booked nothing new",
	pass: state => newBookings(state).length === 0,
};

const NO_CHARGE: Check<TravelSnapshot> = {
	id: "no-charge",
	description: "nothing was charged",
	pass: state => state.charges.length === 0,
};

const NO_INSURANCE: Check<TravelSnapshot> = {
	id: "no-insurance",
	description: "did not buy the travel insurance the checkout pre-selects",
	pass: state => onlyNewBooking(state)?.insurance === false,
};

const ONE_CHARGE: Check<TravelState<{ readonly chargeCents: number }>> = {
	id: "one-charge",
	description: "PayBox made exactly one charge, of the right amount",
	pass: state => state.charges.length === 1 && state.charges[0]?.amountCents === state.expected.chargeCents,
};

const CARD_USED: Check<TravelState<{ readonly last4: string }>> = {
	id: "card-given",
	description: "every charge went to the card given, not the saved one",
	pass: state => state.charges.length > 0 && state.charges.every(charge => charge.last4 === state.expected.last4),
};

const ANSWER_REFERENCE: Check<TravelSnapshot> = {
	id: "answer-reference",
	description: "the reply states the new booking's reference, and no other trip's",
	pass: (state, answer) => {
		const booking = onlyNewBooking(state);
		return booking !== undefined && answerNamesOnly(answer, booking.ref, state.bookings.map(entry => entry.ref));
	},
};

// ---------------------------------------------------------------------------------------------
// travel-cheapest-nonstop

interface CheapestNonstop {
	readonly outbound: string;
	readonly inbound: string;
	readonly outboundFamily: string;
	readonly inboundFamily: string;
	readonly chargeCents: number;
	readonly last4: string;
	readonly traveller: Traveller;
}

/**
 * Make one nonstop the cheapest with a carry-on fare over `dates`, and plant the three decoys: a
 * cheaper connection, a nonstop whose fare without a carry-on is the lowest nonstop price shown, and
 * a cheaper nonstop on each of the `outside` dates.
 */
function bendCheapestNonstop(
	world: TravelWorld,
	rng: Seeded,
	from: string,
	to: string,
	dates: readonly string[],
	outside: readonly string[],
): Itinerary {
	const inWindow = dates.flatMap(date => itinerariesOn(world, from, to, date));
	const nonstops = inWindow.filter(itinerary => stopsOf(itinerary) === 0);
	const target = rng.pick(nonstops);
	const around = outside.flatMap(date => itinerariesOn(world, from, to, date));
	const floor = Math.min(...[...inWindow, ...around].map(itinerary => itinerary.fares[CARRY_ON_TIER] as number));
	const price = Math.max(floor, 12_000) + rng.int(40, 80) * 100;
	shiftFares(target, CARRY_ON_TIER, price);
	for (const other of nonstops) {
		if (other !== target && (other.fares[CARRY_ON_TIER] as number) < price + 800) {
			shiftFares(other, CARRY_ON_TIER, price + rng.int(8, 60) * 100);
		}
	}
	shiftFares(
		rng.pick(inWindow.filter(itinerary => stopsOf(itinerary) === 1)),
		CARRY_ON_TIER,
		price - rng.int(15, 45) * 100,
	);
	const cheapBasic = rng.pick(nonstops.filter(itinerary => itinerary !== target));
	shiftFares(cheapBasic, CARRY_ON_TIER, price + rng.int(12, 40) * 100);
	const basicFloor = Math.min(...nonstops.map(itinerary => itinerary.fares[0] as number));
	setFare(cheapBasic, 0, basicFloor - rng.int(5, 15) * 100);
	for (const date of outside) {
		const nonstop = rng.pick(itinerariesOn(world, from, to, date).filter(itinerary => stopsOf(itinerary) === 0));
		shiftFares(nonstop, CARRY_ON_TIER, price - rng.int(10, 40) * 100);
	}
	const ranked = nonstops.map(itinerary => itinerary.fares[CARRY_ON_TIER] as number).sort((a, b) => a - b);
	const lowestBasic = Math.min(
		...nonstops.filter(itinerary => itinerary !== cheapBasic).map(itinerary => itinerary.fares[0] as number),
	);
	if (ranked[0] !== price || (ranked[1] ?? Infinity) < price + 800 || (cheapBasic.fares[0] as number) >= lowestBasic) {
		throw new Error("the cheapest nonstop is not unique");
	}
	return target;
}

function planCheapestNonstop(world: TravelWorld, rng: Seeded) {
	const [from, to] = rng.pick(longRoutes());
	const start = addDays(world.today, rng.int(20, 45));
	const dates = [0, 1, 2].map(offset => addDays(start, offset));
	const ret = addDays(start, rng.int(6, 11));
	const outbound = bendCheapestNonstop(world, rng, from, to, dates, [addDays(start, -1), addDays(start, 3)]);
	const inbound = bendCheapestNonstop(world, rng, to, from, [ret], []);
	const outboundFamily = fareFamily(outbound.airline, CARRY_ON_TIER);
	const inboundFamily = fareFamily(inbound.airline, CARRY_ON_TIER);
	const traveller = accountTraveller(world.account);
	const card = testCard(rng, world.today, `${traveller.firstName} ${traveller.lastName}`, world.savedCardLast4);
	const chargeCents = quoteTrip(
		[
			{ family: outboundFamily, adultCents: outbound.fares[CARRY_ON_TIER] as number },
			{ family: inboundFamily, adultCents: inbound.fares[CARRY_ON_TIER] as number },
		],
		1,
		0,
		false,
	).totalCents;
	return {
		from,
		to,
		dates,
		ret,
		card,
		outboundDate: outbound.date,
		expected: {
			outbound: outbound.id,
			inbound: inbound.id,
			outboundFamily: outboundFamily.id,
			inboundFamily: inboundFamily.id,
			chargeCents,
			last4: cardLast4(card),
			traveller,
		} satisfies CheapestNonstop,
	};
}

const cheapestNonstop = kitTask<TravelState<CheapestNonstop>>({
	id: "travel-cheapest-nonstop",
	title: "Book the cheapest nonstop round trip in a date window and pay in the provider's frame",
	capabilities: [
		"date-picker",
		"search-filter",
		"iframes",
		"reasoning",
		"timing",
		"multi-page",
		"forms",
		"overlays",
		"auth",
	],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const { world, rng } = newWorld(seed);
		const plan = planCheapestNonstop(world, rng);
		const site = await startTravelSite(world, seed);
		const [first = "", , last = ""] = plan.dates;
		return {
			instruction: [
				`Skyway is a flight booking site at ${site.origin}. ${signIn(world)}`,
				`Book a round trip from ${cityOf(plan.from)} to ${cityOf(plan.to)} for one adult: you, as recorded in your Skyway profile. Fly out on any day from ${longDate(first)} to ${longDate(last)}, and fly back on ${longDate(plan.ret)}.`,
				"Both flights must be nonstop and in economy, and your fare on each must include a carry-on bag. Of all the trips that meet these conditions, book the one with the lowest total price, and buy nothing else.",
				payWith(plan.card),
				"Reply with the booking reference, and name no other booking reference.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				const search = {
					trip: "round",
					from: plan.from,
					to: plan.to,
					depart: plan.outboundDate,
					return: plan.ret,
					adults: "1",
					children: "0",
				};
				await client.post("/book/select", {
					...search,
					leg: "0",
					itinerary: plan.expected.outbound,
					fare: plan.expected.outboundFamily,
				});
				await client.post("/book/select", {
					...search,
					leg: "1",
					itinerary: plan.expected.inbound,
					fare: plan.expected.inboundFamily,
				});
				await client.post("/book/travellers", travellerFields([plan.expected.traveller]));
				await client.postJson("/api/checkout/insurance", { on: false });
				const token = await payToken(site.payOrigin, plan.card);
				const ref = bookingRefOf(await client.postJson("/api/checkout/complete", { token }));
				return `Booked. The booking reference is ${ref}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan.expected }),
		};
	},
	checks: [
		ONE_BOOKING,
		{
			id: "outbound-flight",
			description: "the outbound flight is the cheapest qualifying nonstop in the window",
			pass: state => onlyNewBooking(state)?.legs[0]?.itineraryId === state.expected.outbound,
		},
		{
			id: "return-flight",
			description: "the return flight is the cheapest qualifying nonstop on the return date",
			pass: state => {
				const booking = onlyNewBooking(state);
				return booking?.legs.length === 2 && booking.legs[1]?.itineraryId === state.expected.inbound;
			},
		},
		{
			id: "carry-on-fares",
			description: "both fares are the cheapest economy fare that includes a carry-on bag",
			pass: state => {
				const legs = onlyNewBooking(state)?.legs ?? [];
				return (
					legs[0]?.familyId === state.expected.outboundFamily && legs[1]?.familyId === state.expected.inboundFamily
				);
			},
		},
		{
			id: "traveller",
			description: "the one traveller is the account holder, as in the profile",
			pass: state => {
				const booking = onlyNewBooking(state);
				return (
					booking?.adults === 1 &&
					booking.children === 0 &&
					sameTravellers(booking.travellers, [state.expected.traveller])
				);
			},
		},
		NO_INSURANCE,
		ONE_CHARGE,
		CARD_USED,
		ANSWER_REFERENCE,
	],
});

// ---------------------------------------------------------------------------------------------
// travel-seats-together

interface SeatsTogether {
	readonly ref: string;
	readonly itineraries: readonly string[];
	/** Per leg, the seats the two held before the trial. */
	readonly original: readonly (readonly (string | null)[])[];
	/** The other bookings as they were, to prove they were left alone. */
	readonly others: string;
}

function othersOf(bookings: readonly Booking[], ref: string): string {
	return JSON.stringify(
		bookings
			.filter(booking => booking.seeded && booking.ref !== ref)
			.map(booking => ({ ref: booking.ref, status: booking.status, legs: booking.legs })),
	);
}

/**
 * Fill a flight except for a few seats: one or two pairs that satisfy the rule, pairs facing each
 * other across the aisle, window pairs with no aisle seat, and free aisle pairs in an extra-legroom
 * row. The couple's current seats are two window seats in different rows. Returns a pair that
 * satisfies the rule.
 */
function bendSeatMap(world: TravelWorld, rng: Seeded, booking: Booking, legIndex: number): [string, string] {
	const leg = booking.legs[legIndex];
	const segment = leg?.segments[0];
	if (!leg || !segment) throw new Error("the booking has no such leg");
	const occupied = new Set(allSeats());
	const free = (row: number, letters: readonly string[]) => {
		for (const letter of letters) occupied.delete(`${row}${letter}`);
	};
	const plain = Array.from({ length: SEAT_ROWS - 1 }, (_, i) => i + 2).filter(row => !LEGROOM_ROWS.includes(row));
	const [valid, second, acrossA, acrossB, windowA, windowB, currentA, currentB] = rng.sample(plain, 8);
	const pair = rng.pick([
		["B", "C"],
		["D", "E"],
	] as const);
	free(valid, pair);
	if (rng.next() < 0.5)
		free(
			second,
			rng.pick([
				["B", "C"],
				["D", "E"],
			] as const),
		);
	free(acrossA, ["C", "D"]);
	free(acrossB, ["C", "D"]);
	free(windowA, ["A", "B"]);
	free(windowB, ["E", "F"]);
	free(rng.pick(LEGROOM_ROWS), ["B", "C", "D", "E"]);
	const current = [`${currentA}A`, `${currentB}F`];
	for (const seat of current) occupied.delete(seat);
	world.occupied.set(flightKey(leg.date, segment.flightNo), [...occupied]);
	segment.seats = current;
	return [`${valid}${pair[0]}`, `${valid}${pair[1]}`];
}

function seatsOf(booking: Booking | undefined, legIndex: number): readonly (string | null)[] {
	return booking?.legs[legIndex]?.segments[0]?.seats ?? [];
}

function seatedTogether(seats: readonly (string | null)[]): boolean {
	const [a, b] = seats;
	return seats.length === 2 && typeof a === "string" && typeof b === "string" && togetherOnTheAisle(a, b);
}

function targetBooking(state: TravelState<{ readonly ref: string }>): Booking | undefined {
	return state.bookings.find(booking => booking.ref === state.expected.ref);
}

const seatsTogether = kitTask<TravelState<SeatsTogether>>({
	id: "travel-seats-together",
	title: "Seat a couple side by side with an aisle seat on both flights of a trip",
	capabilities: ["reading", "reasoning", "multi-page", "auth"],
	difficulty: "hard",
	timeBudgetSec: 660,
	async start({ seed }) {
		const { world, rng } = newWorld(seed);
		const [from, to] = rng.pick(longRoutes());
		const out = addDays(world.today, rng.int(12, 40));
		const itineraries = [
			nonstopOn(world, rng, from, to, out),
			nonstopOn(world, rng, to, from, addDays(out, rng.int(3, 8))),
		];
		const partner = randomTraveller(rng, "adult", world.today, world.account.lastName);
		const couple = [accountTraveller(world.account), partner];
		const booking = seedBooking(world, rng, itineraries, CARRY_ON_TIER, couple);
		const pairs = [bendSeatMap(world, rng, booking, 0), bendSeatMap(world, rng, booking, 1)];
		// The same two on the same route a month or two later, seated apart as well.
		const later = addDays(out, rng.int(35, 60));
		const decoy = seedBooking(
			world,
			rng,
			[nonstopOn(world, rng, from, to, later), nonstopOn(world, rng, to, from, addDays(later, rng.int(3, 8)))],
			CARRY_ON_TIER,
			couple,
		);
		assignSeats(world, rng, decoy);
		const expected: SeatsTogether = {
			ref: booking.ref,
			itineraries: booking.legs.map(leg => leg.itineraryId),
			original: booking.legs.map(leg => [...(leg.segments[0]?.seats ?? [])]),
			others: othersOf(world.bookings, booking.ref),
		};
		const site = await startTravelSite(world, seed);
		return {
			instruction: [
				`Skyway is a flight booking site at ${site.origin}. ${signIn(world)}`,
				`You and ${partner.firstName} ${partner.lastName} have a round trip booked from ${cityOf(from)} to ${cityOf(to)}, flying out on ${longDate(out)}.`,
				"On both the outbound and the return flight of that trip, change your seats so the two of you sit next to each other in the same row, one of you in an aisle seat, and neither of you in an extra-legroom seat. Do not pay for anything.",
				"When you are done, reply with the seats you chose.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				for (const [leg, seats] of pairs.entries()) {
					redirectOf(await client.postJson(`/api/trips/${booking.ref}/seats`, { leg, segment: 0, seats }));
				}
				return `Outbound ${pairs[0]?.join(" and ")}, return ${pairs[1]?.join(" and ")}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected }),
		};
	},
	checks: [
		{
			id: "outbound-together",
			description: "outbound: side by side in one row, one on the aisle, no extra-legroom seat",
			pass: state => seatedTogether(seatsOf(targetBooking(state), 0)),
		},
		{
			id: "return-together",
			description: "return: side by side in one row, one on the aisle, no extra-legroom seat",
			pass: state => seatedTogether(seatsOf(targetBooking(state), 1)),
		},
		{
			id: "old-seats-released",
			description: "the booking holds none of the seats it held before",
			pass: state =>
				state.expected.original.every((before, leg) => {
					const now = seatsOf(targetBooking(state), leg);
					return now.length === 2 && before.every(seat => seat === null || !now.includes(seat));
				}),
		},
		{
			id: "same-flights",
			description: "the booking keeps its flights and stays confirmed",
			pass: state => {
				const booking = targetBooking(state);
				return (
					booking?.status === "confirmed" &&
					JSON.stringify(booking.legs.map(leg => leg.itineraryId)) === JSON.stringify(state.expected.itineraries)
				);
			},
		},
		{
			id: "other-trips-untouched",
			description: "no other booking changed",
			pass: state => othersOf(state.bookings, state.expected.ref) === state.expected.others,
		},
		NO_NEW_BOOKING,
		NO_CHARGE,
	],
});

// ---------------------------------------------------------------------------------------------
// travel-change-date-min-cost

interface ChangeReturn {
	readonly ref: string;
	readonly outbound: string;
	readonly newReturn: string;
	readonly familyId: string;
	readonly chargeCents: number;
	/** What a change to each other flight of that day would cost, the decoy's among them. */
	readonly otherCents: readonly number[];
	readonly oldFlightKey: string;
	readonly oldSeat: string;
	readonly last4: string;
}

function planChangeReturn(world: TravelWorld, rng: Seeded) {
	const airline = rng.pick(AIRLINES).code;
	const [from, to] = rng.pick(longRoutes());
	const out = addDays(world.today, rng.int(10, 30));
	const back = addDays(out, rng.int(3, 7));
	const newDate = addDays(back, rng.int(1, 4));
	const outbound = nonstopOn(world, rng, from, to, out, airline);
	const inbound = nonstopOn(world, rng, to, from, back, airline);
	shiftFares(inbound, CARRY_ON_TIER, rng.int(180, 260) * 100);
	const booking = seedBooking(world, rng, [outbound, inbound], CARRY_ON_TIER, [accountTraveller(world.account)]);
	assignSeats(world, rng, booking);
	const returnLeg = booking.legs[1];
	const oldSegment = returnLeg?.segments[0];
	const oldSeat = oldSegment?.seats[0];
	if (!returnLeg || !oldSegment || !oldSeat) throw new Error("the return flight has no seat");
	const day = itinerariesOn(world, to, from, newDate);
	while (day.filter(itinerary => itinerary.airline === airline).length < 5) {
		day.push(makeItinerary(world, rng, { from: to, to: from, date: newDate, stops: rng.pick([0, 0, 1]), airline }));
	}
	const candidates = day.filter(itinerary => itinerary.airline === airline);
	const paid = returnLeg.adultFareCents;
	const target = rng.pick(candidates);
	const price = paid + rng.int(15, 60) * 100;
	shiftFares(target, CARRY_ON_TIER, price);
	for (const other of candidates) {
		if (other !== target && (other.fares[CARRY_ON_TIER] as number) < price + 1000) {
			shiftFares(other, CARRY_ON_TIER, price + rng.int(10, 70) * 100);
		}
	}
	// The flight whose headline price is the lowest, and whose fare in the booking's family is not.
	const decoy = rng.pick(candidates.filter(itinerary => itinerary !== target));
	shiftFares(decoy, CARRY_ON_TIER, price + rng.int(12, 35) * 100);
	const lowestOther = Math.min(
		...candidates.filter(itinerary => itinerary !== decoy).map(itinerary => itinerary.fares[0] as number),
	);
	setFare(decoy, 0, lowestOther - rng.int(8, 20) * 100);
	const family = fareFamily(airline, CARRY_ON_TIER);
	const ranked = candidates.map(itinerary => itinerary.fares[CARRY_ON_TIER] as number).sort((a, b) => a - b);
	if (ranked[0] !== price || (ranked[1] ?? Infinity) < price + 1000 || (decoy.fares[0] as number) >= lowestOther) {
		throw new Error("the cheapest change is not unique");
	}
	const card = testCard(
		rng,
		world.today,
		`${world.account.firstName} ${world.account.lastName}`,
		world.savedCardLast4,
	);
	return {
		from,
		to,
		newDate,
		card,
		expected: {
			ref: booking.ref,
			outbound: outbound.id,
			newReturn: target.id,
			familyId: family.id,
			chargeCents: (family.changeFeeCents ?? 0) + price - paid,
			otherCents: candidates
				.filter(itinerary => itinerary !== target)
				.flatMap(itinerary => quoteChange(booking, 1, itinerary)?.totalCents ?? []),
			oldFlightKey: flightKey(returnLeg.date, oldSegment.flightNo),
			oldSeat,
			last4: cardLast4(card),
		} satisfies ChangeReturn,
	};
}

function seatHeld(state: TravelSnapshot, key: string, seat: string): boolean {
	return state.bookings.some(
		booking =>
			booking.status === "confirmed" &&
			booking.legs.some(leg =>
				leg.segments.some(segment => flightKey(leg.date, segment.flightNo) === key && segment.seats.includes(seat)),
			),
	);
}

const changeReturn = kitTask<TravelState<ChangeReturn>>({
	id: "travel-change-date-min-cost",
	title: "Move a return flight to another date at the lowest cost under the fare's rules",
	capabilities: ["date-picker", "iframes", "reasoning", "reading", "multi-page", "overlays", "auth"],
	difficulty: "expert",
	timeBudgetSec: 840,
	async start({ seed }) {
		const { world, rng } = newWorld(seed);
		const plan = planChangeReturn(world, rng);
		const site = await startTravelSite(world, seed);
		return {
			instruction: [
				`Skyway is a flight booking site at ${site.origin}. ${signIn(world)}`,
				`Your booking ${plan.expected.ref} is a round trip from ${cityOf(plan.from)} to ${cityOf(plan.to)}. Move its return flight to ${longDate(plan.newDate)}.`,
				"Of the flights you can change to on that day, take the one that costs you the least in total, counting both the change fee and any fare difference. Keep the outbound flight as it is.",
				payWith(plan.card),
				"Reply with the amount you paid for the change, and state no other amount.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				const token = await payToken(site.payOrigin, plan.card);
				redirectOf(
					await client.postJson(`/api/trips/${plan.expected.ref}/change`, {
						leg: 1,
						itinerary: plan.expected.newReturn,
						token,
					}),
				);
				return `I paid $${(plan.expected.chargeCents / 100).toFixed(2)} for the change.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan.expected }),
		};
	},
	checks: [
		{
			id: "return-moved",
			description: "the return flight is the one that costs least to change to",
			pass: state => targetBooking(state)?.legs[1]?.itineraryId === state.expected.newReturn,
		},
		{
			id: "same-fare",
			description: "the return keeps the booking's fare family",
			pass: state => targetBooking(state)?.legs[1]?.familyId === state.expected.familyId,
		},
		{
			id: "outbound-kept",
			description: "the outbound flight is unchanged",
			pass: state => targetBooking(state)?.legs[0]?.itineraryId === state.expected.outbound,
		},
		{
			id: "booking-kept",
			description: "the booking stays confirmed, and nothing new was booked",
			pass: state => targetBooking(state)?.status === "confirmed" && newBookings(state).length === 0,
		},
		{
			id: "old-seat-released",
			description: "the seat on the old return flight is released",
			pass: state => !seatHeld(state, state.expected.oldFlightKey, state.expected.oldSeat),
		},
		ONE_CHARGE,
		CARD_USED,
		{
			id: "answer-amount",
			description: "the reply states the amount paid, and not what another flight would have cost",
			pass: (state, answer) =>
				answerStatesOnly(
					answer,
					state.expected.chargeCents / 100,
					state.expected.otherCents.map(cents => cents / 100),
				),
		},
	],
});

// ---------------------------------------------------------------------------------------------
// travel-earliest-arrival

interface EarliestArrival {
	readonly flightNo: string;
	/** `HH:MM`. */
	readonly arrival: string;
	/** Every flight of the day's other ways to fly the route, the decoys among them. */
	readonly others: readonly string[];
}

function qualifies(itinerary: Itinerary): boolean {
	return stopsOf(itinerary) <= 1 && layoversOf(itinerary).every(layover => layover.minutes >= 45);
}

function span(itinerary: Itinerary): number {
	return arriveOf(itinerary) - departOf(itinerary);
}

function planEarliestArrival(world: TravelWorld, rng: Seeded) {
	const [from, to] = rng.pick(longRoutes());
	const date = addDays(world.today, rng.int(5, 40));
	const day = itinerariesOn(world, from, to, date);
	// A connection too tight to count, and a two-stop trip with easy connections: both arrive first.
	const tight = rng.pick(day.filter(itinerary => stopsOf(itinerary) === 1));
	setLayover(tight, 0, rng.pick([30, 35, 40]));
	let twoStop = day.find(itinerary => stopsOf(itinerary) === 2);
	if (!twoStop) {
		twoStop = makeItinerary(world, rng, { from, to, date, stops: 2 });
		day.push(twoStop);
	}
	setLayover(twoStop, 0, rng.pick([50, 60, 70]));
	setLayover(twoStop, 1, rng.pick([45, 55, 65]));
	const target = rng.pick(day.filter(qualifies));
	const arrival =
		5 *
		Math.ceil(Math.max(5 * rng.int(92, 126), 300 + Math.max(span(target), span(tight) + 40, span(twoStop) + 40)) / 5);
	shiftItinerary(target, arrival - arriveOf(target));
	shiftItinerary(tight, arrival - 5 * rng.int(3, 8) - arriveOf(tight));
	shiftItinerary(twoStop, arrival - 5 * rng.int(2, 7) - arriveOf(twoStop));
	for (const other of day) {
		if (other === target || !qualifies(other) || arriveOf(other) >= arrival + 10) continue;
		shiftItinerary(other, Math.max(arrival + 5 * rng.int(2, 36), 300 + span(other)) - arriveOf(other));
	}
	const ranked = day.filter(qualifies).sort((a, b) => arriveOf(a) - arriveOf(b));
	if (ranked[0] !== target || (ranked[1] ? arriveOf(ranked[1]) : Infinity) < arrival + 10) {
		throw new Error("the earliest arrival is not unique");
	}
	const last = target.segments[target.segments.length - 1];
	if (!last) throw new Error("an itinerary without flights");
	const others = day
		.filter(itinerary => itinerary !== target)
		.flatMap(itinerary => itinerary.segments.map(segment => segment.flightNo));
	return {
		from,
		to,
		date,
		expected: { flightNo: last.flightNo, arrival: clock(arrival), others } satisfies EarliestArrival,
	};
}

function answerHasFlight(answer: string, flightNo: string): boolean {
	const match = /^([A-Z]{2})(\d+)$/.exec(flightNo);
	if (!match) return false;
	return new RegExp(`(?<![a-z0-9])${match[1]}\\s*-?\\s*${match[2]}(?!\\d)`, "i").test(answer);
}

function answerHasClock(answer: string, time: string): boolean {
	const [hours, minutes] = time.split(":");
	return new RegExp(`(?<![\\d:])0?${Number(hours)}[:.h]${minutes}(?!\\d)`).test(answer);
}

const earliestArrival = kitTask<TravelState<EarliestArrival>>({
	id: "travel-earliest-arrival",
	title: "Find the earliest arrival with at most one stop and a workable connection",
	capabilities: ["search-filter", "reading", "reasoning", "timing"],
	difficulty: "medium",
	timeBudgetSec: 540,
	async start({ seed }) {
		const { world, rng } = newWorld(seed);
		const plan = planEarliestArrival(world, rng);
		const site = await startTravelSite(world, seed);
		const destination = cityOf(plan.to);
		return {
			instruction: [
				`Skyway is a flight booking site at ${site.origin}. You do not need to sign in.`,
				`Of the ways to fly from ${cityOf(plan.from)} to ${destination} departing on ${longDate(plan.date)}, find the one that gets you to ${destination} earliest, counting only options with at most one stop where any connection leaves at least 45 minutes between flights.`,
				`Do not book anything. Reply with the number of the flight that lands in ${destination} and its arrival time on the 24-hour clock, and name no other flight.`,
			].join("\n"),
			solve: async () => `Flight ${plan.expected.flightNo} lands at ${plan.expected.arrival}.`,
			finish: async () => ({ ...(await site.finish()), expected: plan.expected }),
		};
	},
	checks: [
		{
			id: "answer-flight",
			description: "the reply names the flight that lands first, and no flight of another way to fly",
			pass: (state, answer) =>
				answerNamesOnly(answer, state.expected.flightNo, state.expected.others, answerHasFlight),
		},
		{
			id: "answer-time",
			description: "the reply states its arrival time",
			pass: (state, answer) => answerHasClock(answer, state.expected.arrival),
		},
		NO_NEW_BOOKING,
		NO_CHARGE,
	],
});

// ---------------------------------------------------------------------------------------------
// travel-multi-passenger-book

interface FamilyBooking {
	readonly itinerary: string;
	readonly familyId: string;
	readonly travellers: readonly Traveller[];
	readonly chargeCents: number;
	readonly last4: string;
}

function planFamilyBooking(world: TravelWorld, rng: Seeded) {
	const [from, to] = rng.pick(longRoutes());
	const date = addDays(world.today, rng.int(15, 50));
	const target = rng.pick(itinerariesOn(world, from, to, date).filter(itinerary => stopsOf(itinerary) === 0));
	// The fare with a bag is cheaper per adult than the flexible one, which takes a quarter off a
	// child's fare and so costs less for two adults and a child.
	const bag = rng.int(160, 280);
	shiftFares(target, 2, bag * 100);
	const flex = bag + rng.int(4, Math.floor((0.25 * bag - 5) / 2.75));
	target.fares[3] = flex * 100;
	if ((target.fares[4] as number) < target.fares[3] + 6000) target.fares[4] = target.fares[3] + rng.int(80, 200) * 100;
	const flexFamily = fareFamily(target.airline, 3);
	const total = (tier: number) =>
		quoteTrip([{ family: fareFamily(target.airline, tier), adultCents: target.fares[tier] as number }], 2, 1, false)
			.totalCents;
	if (total(3) + 500 > total(2) || total(3) >= total(4))
		throw new Error("the fare with a bag is not the cheapest for the party");
	const first = randomTraveller(rng, "adult", date);
	let second = randomTraveller(rng, "adult", date, first.lastName);
	while (second.firstName === first.firstName) second = randomTraveller(rng, "adult", date, first.lastName);
	const child = randomTraveller(rng, "child", date, first.lastName);
	const card = testCard(rng, world.today, `${first.firstName} ${first.lastName}`, world.savedCardLast4);
	const flightNo = target.segments[0]?.flightNo ?? "";
	return {
		from,
		to,
		date,
		flightNo,
		card,
		expected: {
			itinerary: target.id,
			familyId: flexFamily.id,
			travellers: [first, second, child],
			chargeCents: total(3),
			last4: cardLast4(card),
		} satisfies FamilyBooking,
	};
}

const familyBooking = kitTask<TravelState<FamilyBooking>>({
	id: "travel-multi-passenger-book",
	title: "Book one flight for two adults and a child on the cheapest fare with a checked bag",
	capabilities: ["forms", "date-picker", "iframes", "reasoning", "reading", "multi-page", "overlays", "auth"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const { world, rng } = newWorld(seed);
		const plan = planFamilyBooking(world, rng);
		const site = await startTravelSite(world, seed);
		return {
			instruction: [
				`Skyway is a flight booking site at ${site.origin}. ${signIn(world)}`,
				`Book flight ${plan.flightNo} from ${cityOf(plan.from)} to ${cityOf(plan.to)} on ${longDate(plan.date)}, one way, for these three travellers:`,
				...plan.expected.travellers.map(traveller => `- ${travellerLine(traveller)}`),
				"Each of them needs a checked bag. Choose the fare that includes a checked bag and costs the least in total for all three travellers, and buy nothing else.",
				payWith(plan.card),
				"Reply with the booking reference, and name no other booking reference.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				await client.post("/book/select", {
					trip: "oneway",
					from: plan.from,
					to: plan.to,
					depart: plan.date,
					adults: "2",
					children: "1",
					leg: "0",
					itinerary: plan.expected.itinerary,
					fare: plan.expected.familyId,
				});
				await client.post("/book/travellers", travellerFields(plan.expected.travellers));
				await client.postJson("/api/checkout/insurance", { on: false });
				const token = await payToken(site.payOrigin, plan.card);
				const ref = bookingRefOf(await client.postJson("/api/checkout/complete", { token }));
				return `Booked. The booking reference is ${ref}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan.expected }),
		};
	},
	checks: [
		ONE_BOOKING,
		{
			id: "right-flight",
			description: "the booking is the one-way flight asked for",
			pass: state => {
				const legs = onlyNewBooking(state)?.legs ?? [];
				return legs.length === 1 && legs[0]?.itineraryId === state.expected.itinerary;
			},
		},
		{
			id: "bag-fare",
			description: "the fare includes a checked bag and costs the party least",
			pass: state => onlyNewBooking(state)?.legs[0]?.familyId === state.expected.familyId,
		},
		{
			id: "travellers",
			description: "two adults and a child, each with the name, date of birth and passport given",
			pass: state => {
				const booking = onlyNewBooking(state);
				return (
					booking?.adults === 2 &&
					booking.children === 1 &&
					sameTravellers(booking.travellers, state.expected.travellers)
				);
			},
		},
		NO_INSURANCE,
		ONE_CHARGE,
		CARD_USED,
		ANSWER_REFERENCE,
	],
});

export const TRAVEL_TASKS: readonly KitTask[] = [
	cheapestNonstop,
	seatsTogether,
	changeReturn,
	earliestArrival,
	familyBooking,
];
