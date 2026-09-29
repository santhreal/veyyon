/**
 * Skyway's world: airports, airlines and their fare families, flights generated day by day from the
 * seed, seat maps, the account's bookings, and the one pricing rule every page and grader uses.
 *
 * A route's flights on a date are generated the first time anything asks for them, from a seed of
 * the world, the route and the date, so a task's planner can materialize the days it bends before
 * the site starts and every other day stays reachable for browsing.
 */

import { Seeded, seedOf } from "../../../../engine/kit/seeded";

export interface Airport {
	readonly code: string;
	readonly city: string;
	readonly name: string;
	/** Position on a 100 by 100 map; flight times follow the distance. */
	readonly x: number;
	readonly y: number;
	/** Connections are made through hubs. */
	readonly hub: boolean;
}

export const AIRPORTS: readonly Airport[] = [
	{ code: "NPT", city: "Northport", name: "Northport International", x: 12, y: 18, hub: false },
	{ code: "MLW", city: "Marlow", name: "Marlow Field", x: 84, y: 72, hub: false },
	{ code: "MWB", city: "Marlowe Bay", name: "Marlowe Bay Regional", x: 90, y: 40, hub: false },
	{ code: "BRW", city: "Brightwater", name: "Brightwater Airport", x: 20, y: 88, hub: false },
	{ code: "CAL", city: "Calder", name: "Calder City Airport", x: 48, y: 45, hub: true },
	{ code: "HVN", city: "Havenford", name: "Havenford International", x: 38, y: 62, hub: true },
	{ code: "LKS", city: "Lakeshore", name: "Lakeshore Municipal", x: 70, y: 12, hub: false },
	{ code: "PEL", city: "Port Ellis", name: "Port Ellis Airport", x: 8, y: 55, hub: false },
	{ code: "PEN", city: "Port Ellison", name: "Port Ellison Regional", x: 94, y: 90, hub: false },
	{ code: "RDG", city: "Redgate", name: "Redgate International", x: 60, y: 35, hub: true },
	{ code: "SLV", city: "Silverton", name: "Silverton Airport", x: 30, y: 30, hub: false },
	{ code: "WXF", city: "Wexford Hills", name: "Wexford Hills Airport", x: 64, y: 88, hub: false },
];

export interface Airline {
	readonly code: string;
	readonly name: string;
	/** Fare family names, by tier. */
	readonly families: readonly string[];
	/** The change fee per traveller of the fares that charge one. */
	readonly changeFeeCents: number;
}

export const AIRLINES: readonly Airline[] = [
	{
		code: "AU",
		name: "Aurora Air",
		families: ["Lite", "Classic", "Classic Bag", "Flex", "Business"],
		changeFeeCents: 7500,
	},
	{
		code: "BW",
		name: "Bluewing",
		families: ["Basic", "Main", "Main Plus", "Main Flex", "Premier"],
		changeFeeCents: 9000,
	},
	{
		code: "CR",
		name: "Cirrus Lines",
		families: ["Saver", "Standard", "Standard Plus", "Freedom", "Business"],
		changeFeeCents: 6000,
	},
	{
		code: "EV",
		name: "Evergreen Airways",
		families: ["Go", "Smart", "Smart Bag", "Flexi", "Business"],
		changeFeeCents: 8000,
	},
	{
		code: "FA",
		name: "Falcon Air",
		families: ["Economy Light", "Economy", "Economy Bag", "Economy Flex", "First"],
		changeFeeCents: 7000,
	},
];

export interface FareFamily {
	/** `<airline>-<tier>`. */
	readonly id: string;
	readonly airline: string;
	/** 0 is the cheapest economy fare, 4 the business cabin. */
	readonly tier: number;
	readonly name: string;
	readonly cabin: "Economy" | "Business";
	readonly carryOn: boolean;
	readonly checkedBags: number;
	/** The fee per traveller to change a flight; null when the fare cannot be changed. */
	readonly changeFeeCents: number | null;
	readonly refundable: boolean;
	/** A child's fare as a percentage of an adult's. */
	readonly childPercent: number;
	readonly freeStandardSeats: boolean;
	readonly freeLegroomSeats: boolean;
}

interface TierRule {
	readonly cabin: FareFamily["cabin"];
	readonly carryOn: boolean;
	readonly checkedBags: number;
	readonly changeable: boolean;
	readonly feeWaived: boolean;
	readonly refundable: boolean;
	readonly childPercent: number;
	readonly freeStandardSeats: boolean;
	readonly freeLegroomSeats: boolean;
}

const TIER_RULES: readonly TierRule[] = [
	{
		cabin: "Economy",
		carryOn: false,
		checkedBags: 0,
		changeable: false,
		feeWaived: false,
		refundable: false,
		childPercent: 100,
		freeStandardSeats: false,
		freeLegroomSeats: false,
	},
	{
		cabin: "Economy",
		carryOn: true,
		checkedBags: 0,
		changeable: true,
		feeWaived: false,
		refundable: false,
		childPercent: 100,
		freeStandardSeats: true,
		freeLegroomSeats: false,
	},
	{
		cabin: "Economy",
		carryOn: true,
		checkedBags: 1,
		changeable: true,
		feeWaived: false,
		refundable: false,
		childPercent: 100,
		freeStandardSeats: true,
		freeLegroomSeats: false,
	},
	{
		cabin: "Economy",
		carryOn: true,
		checkedBags: 1,
		changeable: true,
		feeWaived: true,
		refundable: true,
		childPercent: 75,
		freeStandardSeats: true,
		freeLegroomSeats: true,
	},
	{
		cabin: "Business",
		carryOn: true,
		checkedBags: 2,
		changeable: true,
		feeWaived: true,
		refundable: true,
		childPercent: 100,
		freeStandardSeats: true,
		freeLegroomSeats: true,
	},
];

export const TIERS = TIER_RULES.length;
/** The fare family that first includes a carry-on bag. */
export const CARRY_ON_TIER = 1;

export function airportByCode(code: string): Airport | undefined {
	return AIRPORTS.find(airport => airport.code === code);
}

export function cityOf(code: string): string {
	return airportByCode(code)?.city ?? code;
}

export function airlineByCode(code: string): Airline {
	const airline = AIRLINES.find(entry => entry.code === code);
	if (!airline) throw new Error(`unknown airline ${code}`);
	return airline;
}

export function fareFamily(airlineCode: string, tier: number): FareFamily {
	const airline = airlineByCode(airlineCode);
	const rule = TIER_RULES[tier];
	const name = airline.families[tier];
	if (!rule || !name) throw new Error(`no fare tier ${tier}`);
	return {
		id: `${airline.code}-${tier}`,
		airline: airline.code,
		tier,
		name,
		cabin: rule.cabin,
		carryOn: rule.carryOn,
		checkedBags: rule.checkedBags,
		changeFeeCents: rule.changeable ? (rule.feeWaived ? 0 : airline.changeFeeCents) : null,
		refundable: rule.refundable,
		childPercent: rule.childPercent,
		freeStandardSeats: rule.freeStandardSeats,
		freeLegroomSeats: rule.freeLegroomSeats,
	};
}

export function familyById(id: string): FareFamily | undefined {
	const match = /^([A-Z]{2})-(\d)$/.exec(id);
	if (!match) return undefined;
	const tier = Number(match[2]);
	if (!AIRLINES.some(airline => airline.code === match[1]) || tier >= TIERS) return undefined;
	return fareFamily(match[1] as string, tier);
}

// ---------------------------------------------------------------------------------------------
// Dates and times

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function utc(date: string): Date {
	return new Date(`${date}T00:00:00Z`);
}

export function isIsoDate(value: string): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}$/.test(value) &&
		!Number.isNaN(utc(value).getTime()) &&
		utc(value).toISOString().startsWith(value)
	);
}

export function addDays(date: string, days: number): string {
	return new Date(utc(date).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
	return Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);
}

/** `Tuesday 16 March 2027`. */
export function longDate(date: string): string {
	const day = utc(date);
	return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/** `Tue 16 Mar 2027`. */
export function shortDate(date: string): string {
	const day = utc(date);
	return `${WEEKDAYS[day.getUTCDay()]?.slice(0, 3)} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]?.slice(0, 3)} ${day.getUTCFullYear()}`;
}

/** `16 March 2027`, the way a traveller's date of birth is written in an instruction. */
export function birthDate(date: string): string {
	const day = utc(date);
	return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/** `HH:MM` of minutes after midnight; a time past midnight wraps. */
export function clock(minutes: number): string {
	const within = ((minutes % 1440) + 1440) % 1440;
	return `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
}

export function durationText(minutes: number): string {
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Whole years from `dob` to `date`. */
export function ageOn(dob: string, date: string): number {
	const birth = utc(dob);
	const on = utc(date);
	let age = on.getUTCFullYear() - birth.getUTCFullYear();
	if (
		on.getUTCMonth() < birth.getUTCMonth() ||
		(on.getUTCMonth() === birth.getUTCMonth() && on.getUTCDate() < birth.getUTCDate())
	) {
		age--;
	}
	return age;
}

// ---------------------------------------------------------------------------------------------
// Flights

export interface Segment {
	readonly flightNo: string;
	readonly from: string;
	readonly to: string;
	/** Minutes after midnight of the itinerary's date; past 1440 is the next day. */
	departMin: number;
	arriveMin: number;
}

/** One way to fly a route on a date: one or more flights of one airline, with the fares it sells. */
export interface Itinerary {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly date: string;
	readonly airline: string;
	readonly segments: Segment[];
	/** The adult fare of each fare family, by tier, in cents. */
	readonly fares: number[];
}

export function stopsOf(itinerary: Itinerary): number {
	return itinerary.segments.length - 1;
}

export function departOf(itinerary: Pick<Itinerary, "segments">): number {
	return (itinerary.segments[0] as Segment).departMin;
}

export function arriveOf(itinerary: Pick<Itinerary, "segments">): number {
	return (itinerary.segments[itinerary.segments.length - 1] as Segment).arriveMin;
}

export interface Layover {
	readonly airport: string;
	readonly minutes: number;
}

export function layoversOf(itinerary: Pick<Itinerary, "segments">): Layover[] {
	return itinerary.segments.slice(1).map((segment, index) => ({
		airport: segment.from,
		minutes: segment.departMin - (itinerary.segments[index] as Segment).arriveMin,
	}));
}

/** The flights a seat map and a flight number belong to: a flight number is unique on its date. */
export function flightKey(date: string, flightNo: string): string {
	return `${flightNo}|${date}`;
}

const LAYOVERS = [30, 35, 40, 50, 55, 65, 75, 90, 110, 140];

function flightMinutes(from: string, to: string): number {
	const a = airportByCode(from);
	const b = airportByCode(to);
	if (!a || !b) throw new Error(`unknown route ${from}-${to}`);
	return Math.round((35 + Math.hypot(a.x - b.x, a.y - b.y) * 1.6) / 5) * 5;
}

function fareLadder(rng: Seeded, minutes: number, stops: number): number[] {
	const base = Math.max(49, Math.round(40 + minutes * 0.55 - stops * 22 + rng.int(-25, 45)));
	const standard = base + rng.int(28, 60);
	const bag = standard + rng.int(30, 45);
	const flex = bag + rng.int(45, 110);
	const business = Math.max(flex + 60, Math.round(base * 2.4) + rng.int(40, 160));
	return [base, standard, bag, flex, business].map(dollars => dollars * 100);
}

export interface ItineraryOptions {
	readonly from: string;
	readonly to: string;
	readonly date: string;
	readonly stops: number;
	readonly airline?: string;
	readonly departMin?: number;
	/** The layover at each connection, in minutes; random when not given. */
	readonly layovers?: readonly number[];
}

function newFlightNumber(world: TravelWorld, rng: Seeded, airline: string, date: string, itineraryId: string): string {
	for (;;) {
		const flightNo = `${airline}${rng.int(100, 2999)}`;
		const key = flightKey(date, flightNo);
		if (world.flightNumbers.has(key)) continue;
		world.flightNumbers.set(key, itineraryId);
		return flightNo;
	}
}

/** A new itinerary on the route and date; it is not listed until it is added to the day. */
export function makeItinerary(world: TravelWorld, rng: Seeded, options: ItineraryOptions): Itinerary {
	const hubs = AIRPORTS.filter(airport => airport.hub && airport.code !== options.from && airport.code !== options.to);
	const stops = Math.min(options.stops, hubs.length);
	const path = [options.from, ...rng.sample(hubs, stops).map(hub => hub.code), options.to];
	const airline = options.airline ?? rng.pick(AIRLINES).code;
	const id = `${options.from}${options.to}-${options.date.replaceAll("-", "")}-${rng.code(4)}`;
	let time = options.departMin ?? 330 + 5 * rng.int(0, 192);
	const segments: Segment[] = [];
	for (let hop = 0; hop < path.length - 1; hop++) {
		const from = path[hop] as string;
		const to = path[hop + 1] as string;
		const minutes = flightMinutes(from, to) + 5 * rng.int(-1, 2);
		segments.push({
			flightNo: newFlightNumber(world, rng, airline, options.date, id),
			from,
			to,
			departMin: time,
			arriveMin: time + minutes,
		});
		time += minutes + (options.layovers?.[hop] ?? rng.pick(LAYOVERS));
	}
	const total = arriveOf({ segments }) - departOf({ segments });
	return {
		id,
		from: options.from,
		to: options.to,
		date: options.date,
		airline,
		segments,
		fares: fareLadder(rng, total, stops),
	};
}

/** Every itinerary of a route on a date, generated the first time it is asked for. */
export function itinerariesOn(world: TravelWorld, from: string, to: string, date: string): Itinerary[] {
	const key = `${from}-${to}-${date}`;
	const existing = world.days.get(key);
	if (existing) return existing;
	const list: Itinerary[] = [];
	world.days.set(key, list);
	if (from === to || !airportByCode(from) || !airportByCode(to)) return list;
	const rng = new Seeded(seedOf(`${world.seed}|${key}`));
	const counts = [rng.int(3, 5), rng.int(4, 7), rng.int(1, 2)];
	counts.forEach((count, stops) => {
		for (let i = 0; i < count; i++) list.push(makeItinerary(world, rng, { from, to, date, stops }));
	});
	return list;
}

export function findItinerary(world: TravelWorld, id: string): Itinerary | undefined {
	for (const list of world.days.values()) {
		const found = list.find(itinerary => itinerary.id === id);
		if (found) return found;
	}
	return undefined;
}

/** Move every flight of an itinerary by `minutes`. */
export function shiftItinerary(itinerary: Itinerary, minutes: number): void {
	for (const segment of itinerary.segments) {
		segment.departMin += minutes;
		segment.arriveMin += minutes;
	}
}

/** Set the gap before one connection, moving the flights after it. */
export function setLayover(itinerary: Itinerary, index: number, minutes: number): void {
	const before = itinerary.segments[index] as Segment;
	const after = itinerary.segments[index + 1] as Segment;
	const delta = before.arriveMin + minutes - after.departMin;
	for (const segment of itinerary.segments.slice(index + 1)) {
		segment.departMin += delta;
		segment.arriveMin += delta;
	}
}

const FARE_STEP_CENTS = 1500;
const MIN_FARE_CENTS = 2900;

/**
 * Set one fare family's adult fare, then move the others only as far as it takes to keep each
 * family dearer than the one below it.
 */
export function setFare(itinerary: Itinerary, tier: number, cents: number): void {
	itinerary.fares[tier] = cents;
	for (let t = tier + 1; t < itinerary.fares.length; t++) {
		const floor = (itinerary.fares[t - 1] as number) + FARE_STEP_CENTS;
		if ((itinerary.fares[t] as number) < floor) itinerary.fares[t] = floor + 1000 * (t - tier);
	}
	for (let t = tier - 1; t >= 0; t--) {
		const ceiling = (itinerary.fares[t + 1] as number) - FARE_STEP_CENTS;
		if ((itinerary.fares[t] as number) > ceiling)
			itinerary.fares[t] = Math.max(MIN_FARE_CENTS, ceiling - 1000 * (tier - t));
	}
}

/** Move every fare family's fare by one amount, so the family of `tier` costs `cents` per adult. */
export function shiftFares(itinerary: Itinerary, tier: number, cents: number): void {
	const delta = cents - (itinerary.fares[tier] as number);
	for (let t = 0; t < itinerary.fares.length; t++) {
		itinerary.fares[t] = Math.max(MIN_FARE_CENTS + t * FARE_STEP_CENTS, (itinerary.fares[t] as number) + delta);
	}
}

// ---------------------------------------------------------------------------------------------
// Seats

export const SEAT_ROWS = 28;
export const SEAT_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
/** The bulkhead and the two exit rows. */
export const LEGROOM_ROWS: readonly number[] = [1, 11, 12];

export function parseSeat(seat: string): { row: number; letter: string } | null {
	const match = /^([1-9]\d?)([A-F])$/.exec(seat);
	if (!match) return null;
	const row = Number(match[1]);
	return row <= SEAT_ROWS ? { row, letter: match[2] as string } : null;
}

export function seatPosition(letter: string): "window" | "middle" | "aisle" {
	if (letter === "A" || letter === "F") return "window";
	if (letter === "C" || letter === "D") return "aisle";
	return "middle";
}

export function isLegroom(seat: string): boolean {
	const parsed = parseSeat(seat);
	return parsed !== null && LEGROOM_ROWS.includes(parsed.row);
}

export function allSeats(): string[] {
	const seats: string[] = [];
	for (let row = 1; row <= SEAT_ROWS; row++) for (const letter of SEAT_LETTERS) seats.push(`${row}${letter}`);
	return seats;
}

/** Two seats of one row with nothing between them; C and D face each other across the aisle. */
export function sideBySide(a: string, b: string): boolean {
	const first = parseSeat(a);
	const second = parseSeat(b);
	if (!first || !second || first.row !== second.row) return false;
	const letters = [first.letter, second.letter].sort().join("");
	return letters === "AB" || letters === "BC" || letters === "DE" || letters === "EF";
}

/** The seating rule of a couple that wants to sit together with one of them on the aisle. */
export function togetherOnTheAisle(a: string, b: string): boolean {
	return (
		sideBySide(a, b) &&
		(seatPosition(parseSeat(a)?.letter ?? "") === "aisle" || seatPosition(parseSeat(b)?.letter ?? "") === "aisle") &&
		!isLegroom(a) &&
		!isLegroom(b)
	);
}

/** Seats sold to other customers on a flight, generated the first time a seat map is shown. */
export function occupiedSeats(world: TravelWorld, key: string): string[] {
	const existing = world.occupied.get(key);
	if (existing) return existing;
	const rng = new Seeded(seedOf(`${world.seed}|seats|${key}`));
	const rate = rng.int(40, 70) / 100;
	const seats = allSeats().filter(() => rng.next() < rate);
	world.occupied.set(key, seats);
	return seats;
}

/** Every seat nobody may choose: sold to others, or held by a confirmed booking other than `exceptRef`. */
export function takenSeats(world: TravelWorld, key: string, exceptRef: string | null): Set<string> {
	const taken = new Set(occupiedSeats(world, key));
	for (const booking of world.bookings) {
		if (booking.status !== "confirmed" || booking.ref === exceptRef) continue;
		for (const leg of booking.legs) {
			for (const segment of leg.segments) {
				if (flightKey(leg.date, segment.flightNo) !== key) continue;
				for (const seat of segment.seats) if (seat) taken.add(seat);
			}
		}
	}
	return taken;
}

// ---------------------------------------------------------------------------------------------
// Bookings and prices

export type TravellerType = "adult" | "child";

export interface Traveller {
	readonly type: TravellerType;
	readonly firstName: string;
	readonly lastName: string;
	/** ISO date. */
	readonly dob: string;
	readonly passport: string;
}

export interface BookedSegment {
	readonly flightNo: string;
	readonly from: string;
	readonly to: string;
	readonly departMin: number;
	readonly arriveMin: number;
	/** Each traveller's seat, in the order of the booking's travellers. */
	seats: (string | null)[];
}

export interface BookedLeg {
	readonly itineraryId: string;
	readonly date: string;
	readonly from: string;
	readonly to: string;
	readonly airline: string;
	readonly familyId: string;
	/** What was paid per adult and per child for this leg's fare. */
	readonly adultFareCents: number;
	readonly childFareCents: number;
	readonly segments: BookedSegment[];
}

export interface Booking {
	readonly ref: string;
	/** Part of the world before the trial started. */
	readonly seeded: boolean;
	status: "confirmed" | "cancelled";
	readonly adults: number;
	readonly children: number;
	readonly travellers: readonly Traveller[];
	legs: BookedLeg[];
	readonly insurance: boolean;
	paidCents: number;
	readonly chargeIds: string[];
}

export interface Account {
	readonly email: string;
	readonly password: string;
	readonly firstName: string;
	readonly lastName: string;
	readonly dob: string;
	readonly passport: string;
}

export interface TravelWorld {
	/** Seeds the lazily generated days and seat maps. */
	readonly seed: number;
	/** The site's date: nothing departs before it. */
	readonly today: string;
	readonly account: Account;
	/** Itineraries by `<from>-<to>-<date>`. */
	readonly days: Map<string, Itinerary[]>;
	/** Seats sold to other customers, by flight key. */
	readonly occupied: Map<string, string[]>;
	/** Which itinerary each flight number of a date belongs to, by flight key. */
	readonly flightNumbers: Map<string, string>;
	readonly bookings: Booking[];
	/** The card PayBox holds for the account. */
	readonly savedCardLast4: string;
}

/** Taxes and carrier fees per traveller per leg. */
export const TAX_CENTS = 2860;
/** The travel insurance the checkout offers, per traveller. */
export const INSURANCE_CENTS = 2900;
export const STANDARD_SEAT_CENTS = 1500;
export const LEGROOM_SEAT_CENTS = 3900;

export function childFareCents(adultCents: number, family: FareFamily): number {
	return Math.round((adultCents * family.childPercent) / 100);
}

export interface PricedLeg {
	readonly family: FareFamily;
	readonly adultCents: number;
}

export interface Quote {
	readonly fareCents: number;
	readonly taxesCents: number;
	readonly insuranceCents: number;
	readonly totalCents: number;
}

/** What a trip costs: the one booking price rule of the site. */
export function quoteTrip(legs: readonly PricedLeg[], adults: number, children: number, insurance: boolean): Quote {
	const travellers = adults + children;
	const fareCents = legs.reduce(
		(sum, leg) => sum + leg.adultCents * adults + childFareCents(leg.adultCents, leg.family) * children,
		0,
	);
	const taxesCents = TAX_CENTS * travellers * legs.length;
	const insuranceCents = insurance ? INSURANCE_CENTS * travellers : 0;
	return { fareCents, taxesCents, insuranceCents, totalCents: fareCents + taxesCents + insuranceCents };
}

export function seatFeeCents(family: FareFamily, seat: string): number {
	if (isLegroom(seat)) return family.freeLegroomSeats ? 0 : LEGROOM_SEAT_CENTS;
	return family.freeStandardSeats ? 0 : STANDARD_SEAT_CENTS;
}

export interface ChangeQuote {
	readonly feeCents: number;
	readonly newAdultCents: number;
	readonly newChildCents: number;
	/** The rise in fare over what was paid, never below zero: a cheaper flight refunds nothing. */
	readonly differenceCents: number;
	readonly totalCents: number;
}

/** What moving one leg of a booking to another itinerary costs, or null when its fare cannot change. */
export function quoteChange(booking: Booking, legIndex: number, itinerary: Itinerary): ChangeQuote | null {
	const leg = booking.legs[legIndex];
	const family = leg ? familyById(leg.familyId) : undefined;
	if (!leg || !family || family.changeFeeCents === null) return null;
	const newAdultCents = itinerary.fares[family.tier] as number;
	const newChildCents = childFareCents(newAdultCents, family);
	const rise =
		(newAdultCents - leg.adultFareCents) * booking.adults + (newChildCents - leg.childFareCents) * booking.children;
	const feeCents = family.changeFeeCents * (booking.adults + booking.children);
	const differenceCents = Math.max(0, rise);
	return { feeCents, newAdultCents, newChildCents, differenceCents, totalCents: feeCents + differenceCents };
}

/** A refundable fare returns everything paid; any other returns the taxes. */
export function cancellationRefundCents(booking: Booking): number {
	const refundable = booking.legs.every(leg => familyById(leg.familyId)?.refundable === true);
	return refundable ? booking.paidCents : TAX_CENTS * booking.travellers.length * booking.legs.length;
}

export function bookLeg(itinerary: Itinerary, family: FareFamily, travellers: number): BookedLeg {
	const adultFareCents = itinerary.fares[family.tier] as number;
	return {
		itineraryId: itinerary.id,
		date: itinerary.date,
		from: itinerary.from,
		to: itinerary.to,
		airline: itinerary.airline,
		familyId: family.id,
		adultFareCents,
		childFareCents: childFareCents(adultFareCents, family),
		segments: itinerary.segments.map(segment => ({
			flightNo: segment.flightNo,
			from: segment.from,
			to: segment.to,
			departMin: segment.departMin,
			arriveMin: segment.arriveMin,
			seats: Array.from({ length: travellers }, () => null),
		})),
	};
}

export function newBookingRef(world: TravelWorld, rng: Seeded): string {
	for (;;) {
		const ref = rng.code(6);
		if (!world.bookings.some(booking => booking.ref === ref)) return ref;
	}
}

export function findBooking(world: TravelWorld, ref: string): Booking | undefined {
	return world.bookings.find(booking => booking.ref === ref);
}

// ---------------------------------------------------------------------------------------------
// People

const FIRST = [
	"Avery",
	"Jordan",
	"Riley",
	"Morgan",
	"Casey",
	"Taylor",
	"Quinn",
	"Rowan",
	"Emery",
	"Harper",
	"Sasha",
	"Devon",
];
const LAST = [
	"Nakamura",
	"Okafor",
	"Lindqvist",
	"Moreau",
	"Castillo",
	"Haddad",
	"Novak",
	"Brennan",
	"Ferreira",
	"Kowalski",
];
const CHILD_FIRST = ["Milo", "Ada", "Theo", "Iris", "Leo", "Nora", "Ezra", "Lila"];
const PASSPORT_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";

export function passportNumber(rng: Seeded): string {
	const letter = () => PASSPORT_LETTERS[rng.int(0, PASSPORT_LETTERS.length - 1)];
	return `${letter()}${letter()}${rng.int(1_000_000, 9_999_999)}`;
}

/** A date of birth that makes the traveller `minAge` to `maxAge` years old on `on`. */
export function birthDateFor(rng: Seeded, on: string, minAge: number, maxAge: number): string {
	return addDays(on, -(minAge * 366 + rng.int(0, (maxAge - minAge) * 365)));
}

export function randomTraveller(rng: Seeded, type: TravellerType, on: string, lastName?: string): Traveller {
	return {
		type,
		firstName: rng.pick(type === "child" ? CHILD_FIRST : FIRST),
		lastName: lastName ?? rng.pick(LAST),
		dob: type === "child" ? birthDateFor(rng, on, 3, 9) : birthDateFor(rng, on, 25, 60),
		passport: passportNumber(rng),
	};
}

export function accountTraveller(account: Account): Traveller {
	return {
		type: "adult",
		firstName: account.firstName,
		lastName: account.lastName,
		dob: account.dob,
		passport: account.passport,
	};
}

/** Pairs of airports that are neither hubs, far enough apart for connections to make sense. */
export function longRoutes(): [string, string][] {
	const outer = AIRPORTS.filter(airport => !airport.hub);
	const routes: [string, string][] = [];
	for (const a of outer) {
		for (const b of outer) {
			if (a.code !== b.code && Math.hypot(a.x - b.x, a.y - b.y) >= 50) routes.push([a.code, b.code]);
		}
	}
	return routes;
}

/** A world with an account and no bookings yet; `today` falls in 2027. */
export function generateTravel(rng: Seeded): TravelWorld {
	const today = addDays("2027-01-04", rng.int(0, 200));
	const firstName = rng.pick(FIRST);
	const lastName = rng.pick(LAST);
	return {
		seed: rng.int(1, 2_000_000_000),
		today,
		account: {
			email: `${firstName}.${lastName}@example.test`.toLowerCase(),
			password: `skyway-${rng.code(6)}`,
			firstName,
			lastName,
			dob: birthDateFor(rng, today, 28, 55),
			passport: passportNumber(rng),
		},
		days: new Map(),
		occupied: new Map(),
		flightNumbers: new Map(),
		bookings: [],
		savedCardLast4: String(rng.int(1000, 9999)),
	};
}
