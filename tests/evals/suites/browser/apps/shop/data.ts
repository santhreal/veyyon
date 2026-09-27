/**
 * The outdoor-gear shop's world: a seeded catalog, an account with its order history, coupons and
 * messages, and the one pricing rule every page and every grader uses.
 */

import type { Seeded } from "../../../../engine/kit/seeded";

export const SIZES = ["S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];
/** The size key of an item that comes in one size. */
export const ONE_SIZE = "One size";

export interface Product {
	readonly sku: string;
	readonly name: string;
	readonly category: string;
	readonly priceCents: number;
	/** One decimal, 1.0 to 5.0. */
	readonly rating: number;
	readonly reviews: number;
	readonly warrantyYears: number;
	readonly description: string;
	/** Units in stock by size; an unsized item has the one key {@link ONE_SIZE}. */
	readonly stock: Record<string, number>;
}

export interface CartLine {
	readonly sku: string;
	readonly size: string;
	quantity: number;
}

export interface Address {
	readonly name: string;
	readonly street: string;
	readonly city: string;
	readonly postalCode: string;
	readonly country: string;
}

export type ShippingId = "standard" | "express" | "overnight";

export const SHIPPING: Readonly<Record<ShippingId, { readonly label: string; readonly cents: number }>> = {
	standard: { label: "Standard (5–7 days)", cents: 599 },
	express: { label: "Express (2 days)", cents: 1499 },
	overnight: { label: "Overnight", cents: 2999 },
};

/** Standard shipping is free from this discounted subtotal up. */
export const FREE_STANDARD_FROM_CENTS = 7500;
export const TAX_RATE = 0.08;

export interface Coupon {
	readonly code: string;
	readonly kind: "percent" | "fixed" | "shipping";
	/** Percent for `percent`, cents for `fixed`, unused for `shipping`. */
	readonly value: number;
	readonly minSubtotalCents: number;
	/** Only items of this category count toward the discount. */
	readonly category: string | null;
}

export interface OrderLine {
	readonly sku: string;
	readonly name: string;
	readonly size: string;
	readonly quantity: number;
	readonly unitCents: number;
}

export interface Totals {
	readonly subtotalCents: number;
	readonly discountCents: number;
	readonly shippingCents: number;
	readonly taxCents: number;
	readonly totalCents: number;
}

export interface Order extends Totals {
	readonly id: string;
	readonly placedAt: string;
	readonly lines: readonly OrderLine[];
	readonly address: Address;
	readonly shipping: ShippingId;
	readonly coupon: string | null;
	/** Present in the account before the trial started. */
	readonly seeded: boolean;
}

export interface ReturnRequest {
	/** `RMA-` and six characters, shown on the order page once the return is requested. */
	readonly reference: string;
	readonly orderId: string;
	readonly lines: readonly { readonly sku: string; readonly size: string; readonly quantity: number }[];
	readonly reason: string;
	readonly refund: string;
	/** What the return refunds, by {@link refundCents}. */
	readonly refundCents: number;
}

export interface Message {
	readonly id: string;
	readonly from: string;
	readonly subject: string;
	readonly body: string;
	readonly date: string;
}

export interface ShopWorld {
	readonly products: Product[];
	readonly account: { readonly email: string; readonly password: string; readonly name: string };
	readonly savedAddress: Address;
	readonly coupons: Coupon[];
	readonly orders: Order[];
	readonly messages: Message[];
	readonly cart: CartLine[];
	appliedCoupon: string | null;
}

export const RETURN_REASONS = ["Damaged", "Wrong item", "Too small", "Too large", "No longer needed"] as const;
export const REFUND_METHODS = ["Original payment", "Store credit"] as const;

const CATEGORIES: Readonly<Record<string, { readonly sized: boolean; readonly nouns: readonly string[] }>> = {
	Jackets: { sized: true, nouns: ["Shell Jacket", "Down Parka", "Fleece Jacket", "Rain Jacket", "Softshell"] },
	Boots: { sized: true, nouns: ["Hiking Boot", "Trail Runner", "Winter Boot", "Approach Shoe"] },
	Shirts: { sized: true, nouns: ["Merino Tee", "Sun Hoodie", "Flannel Shirt", "Base Layer"] },
	Backpacks: { sized: false, nouns: ["Daypack", "Trekking Pack", "Hydration Pack", "Travel Pack"] },
	Tents: { sized: false, nouns: ["Solo Tent", "Two-Person Tent", "Bivy", "Tarp Shelter"] },
	Headlamps: { sized: false, nouns: ["Headlamp", "Lantern", "Trail Light"] },
};

const BRANDS = ["Alder", "Basalt", "Cairn", "Drift", "Ember", "Fjell", "Granite", "Harbor", "Ibex", "Juniper"];
const STREETS = ["Maple Ave", "Oak Street", "Cedar Lane", "Birch Road", "Willow Way", "Pine Court"];
const CITIES = ["Springfield", "Riverton", "Lakeside", "Fairview", "Greenville", "Oakdale"];
const FIRST = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Taylor", "Quinn", "Rowan"];
const LAST = ["Nakamura", "Okafor", "Lindqvist", "Moreau", "Castillo", "Haddad", "Novak", "Brennan"];

export function categories(): string[] {
	return Object.keys(CATEGORIES);
}

export function isSized(category: string): boolean {
	return CATEGORIES[category]?.sized === true;
}

export function randomAddress(rng: Seeded, name?: string): Address {
	return {
		name: name ?? `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
		street: `${rng.int(10, 9899)} ${rng.pick(STREETS)}`,
		city: rng.pick(CITIES),
		postalCode: String(rng.int(10000, 99999)),
		country: "United States",
	};
}

/** A product of `category`, with a SKU no product in `catalog` has: pages and forms find a product by SKU alone. */
function product(rng: Seeded, category: string, catalog: readonly Product[]): Product {
	const spec = CATEGORIES[category];
	if (!spec) throw new Error(`unknown category ${category}`);
	const stock: Record<string, number> = {};
	if (spec.sized) for (const size of SIZES) stock[size] = rng.next() < 0.2 ? 0 : rng.int(1, 9);
	else stock[ONE_SIZE] = rng.next() < 0.15 ? 0 : rng.int(1, 20);
	const brand = rng.pick(BRANDS);
	const noun = rng.pick(spec.nouns);
	let sku = `SK-${rng.code(5)}`;
	while (catalog.some(item => item.sku === sku)) sku = `SK-${rng.code(5)}`;
	return {
		sku,
		name: `${brand} ${noun} ${catalog.length + 1}`,
		category,
		priceCents: rng.int(18, 420) * 100 + rng.pick([0, 49, 95, 99]),
		rating: rng.int(28, 50) / 10,
		reviews: rng.int(3, 900),
		warrantyYears: rng.pick([1, 1, 2, 2, 3, 5]),
		description: `${noun} by ${brand}, built for ${rng.pick(["alpine", "desert", "coastal", "forest", "urban"])} trips.`,
		stock,
	};
}

/** A catalog of about ten products per category, an account, and an empty cart. */
export function generateShop(rng: Seeded): ShopWorld {
	const products: Product[] = [];
	for (const category of categories()) {
		const count = rng.int(9, 12);
		for (let i = 0; i < count; i++) products.push(product(rng, category, products));
	}
	const first = rng.pick(FIRST);
	const last = rng.pick(LAST);
	const name = `${first} ${last}`;
	return {
		products: rng.shuffle(products),
		account: { email: `${first}.${last}@example.test`.toLowerCase(), password: `trail-${rng.code(6)}`, name },
		savedAddress: randomAddress(rng, name),
		coupons: [],
		orders: [],
		messages: [],
		cart: [],
		appliedCoupon: null,
	};
}

export function findProduct(world: Pick<ShopWorld, "products">, sku: string): Product | undefined {
	return world.products.find(item => item.sku === sku);
}

/** The discount a coupon gives on these lines, or 0 when the cart does not qualify. */
export function couponDiscount(world: Pick<ShopWorld, "products">, lines: readonly CartLine[], coupon: Coupon): number {
	const subtotal = subtotalOf(world, lines);
	if (subtotal < coupon.minSubtotalCents) return 0;
	const eligible = lines.reduce((sum, line) => {
		const item = findProduct(world, line.sku);
		if (!item || (coupon.category && item.category !== coupon.category)) return sum;
		return sum + item.priceCents * line.quantity;
	}, 0);
	if (coupon.kind === "percent") return Math.round((eligible * coupon.value) / 100);
	if (coupon.kind === "fixed") return Math.min(coupon.value, eligible);
	return 0;
}

export function subtotalOf(world: Pick<ShopWorld, "products">, lines: readonly CartLine[]): number {
	return lines.reduce((sum, line) => sum + (findProduct(world, line.sku)?.priceCents ?? 0) * line.quantity, 0);
}

/** What an order of these lines costs: the one pricing rule of the shop. */
export function priceOrder(
	world: Pick<ShopWorld, "products">,
	lines: readonly CartLine[],
	coupon: Coupon | null,
	shipping: ShippingId,
): Totals {
	const subtotalCents = subtotalOf(world, lines);
	const discountCents = coupon ? couponDiscount(world, lines, coupon) : 0;
	const afterDiscount = subtotalCents - discountCents;
	const qualifiesForShippingCoupon = coupon?.kind === "shipping" && subtotalCents >= coupon.minSubtotalCents;
	let shippingCents = SHIPPING[shipping].cents;
	if (qualifiesForShippingCoupon) shippingCents = 0;
	else if (shipping === "standard" && afterDiscount >= FREE_STANDARD_FROM_CENTS) shippingCents = 0;
	const taxCents = Math.round(afterDiscount * TAX_RATE);
	return {
		subtotalCents,
		discountCents,
		shippingCents,
		taxCents,
		totalCents: afterDiscount + shippingCents + taxCents,
	};
}

export function describeCoupon(coupon: Coupon): string {
	const scope = coupon.category ? ` on ${coupon.category}` : "";
	const minimum = coupon.minSubtotalCents > 0 ? ` with a subtotal of $${(coupon.minSubtotalCents / 100).toFixed(2)} or more` : "";
	if (coupon.kind === "percent") return `${coupon.value}% off${scope}${minimum}`;
	if (coupon.kind === "fixed") return `$${(coupon.value / 100).toFixed(2)} off${scope}${minimum}`;
	return `Free shipping at any speed${minimum}`;
}

/**
 * What returning these lines of an order refunds: their price less their share of the order's
 * discount, plus the tax on the rest. Shipping is not refunded.
 */
export function refundCents(
	order: Pick<Order, "lines" | "subtotalCents" | "discountCents">,
	indexes: readonly number[],
): number {
	const items = indexes.reduce((sum, index) => {
		const line = order.lines[index];
		return line ? sum + line.unitCents * line.quantity : sum;
	}, 0);
	const discount = order.subtotalCents > 0 ? Math.round((order.discountCents * items) / order.subtotalCents) : 0;
	return items - discount + Math.round((items - discount) * TAX_RATE);
}

/** An order id the account has not used: `W` and six digits. */
export function nextOrderId(world: Pick<ShopWorld, "orders">, rng: Seeded): string {
	for (;;) {
		const id = `W${rng.int(100000, 999999)}`;
		if (!world.orders.some(order => order.id === id)) return id;
	}
}
