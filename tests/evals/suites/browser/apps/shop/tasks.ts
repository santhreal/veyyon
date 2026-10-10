/**
 * Tasks performed against the shop. Each plans its scenario on a freshly seeded world, bending the
 * catalog so the answer is unique and the tempting wrong answers exist, then grades what the shop
 * recorded.
 */

import { answerHasNumber, answerHasText, answerNamesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { FormClient, type FormResponse } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	type Address,
	type CartLine,
	type Coupon,
	categories,
	describeCard,
	findProduct,
	generateShop,
	isSized,
	nextOrderId,
	ONE_SIZE,
	type Order,
	priceOrder,
	type Product,
	randomAddress,
	type SavedCard,
	type ShippingId,
	type ShopWorld,
	SIZES,
	type Size,
} from "./data";
import { type CardDecline, describeLines, type ShopSnapshot, startShopSite } from "./site";

async function signedInClient(origin: string, world: ShopWorld): Promise<FormClient> {
	const client = new FormClient(origin);
	await client.post("/signin", { email: world.account.email, password: world.account.password, next: "/account" });
	return client;
}

function addressFields(address: Address): Record<string, string> {
	return {
		name: address.name,
		street: address.street,
		city: address.city,
		postalCode: address.postalCode,
		country: address.country,
	};
}

function placedOrderId(response: FormResponse): string {
	const id = /Order (W\d+) is placed/.exec(response.body)?.[1];
	if (!id) throw new Error(`the checkout placed no order; it answered ${response.url}`);
	return id;
}

interface Expected<T> {
	readonly expected: T;
}

type ShopState<T> = ShopSnapshot & Expected<T>;

function placedOrders(state: ShopSnapshot): readonly Order[] {
	return state.orders.filter(order => !order.seeded);
}

function onlyOrder(state: ShopSnapshot): Order | undefined {
	const placed = placedOrders(state);
	return placed.length === 1 ? placed[0] : undefined;
}

function sameAddress(a: Address, b: Address): boolean {
	return (["name", "street", "city", "postalCode"] as const).every(key => normalizeText(a[key]) === normalizeText(b[key]));
}

function lineKey(line: { sku: string; size: string; quantity: number }): string {
	return `${line.sku}|${line.size}|${line.quantity}`;
}

function sameLines(a: readonly { sku: string; size: string; quantity: number }[], b: readonly CartLine[]): boolean {
	return JSON.stringify(a.map(lineKey).sort()) === JSON.stringify(b.map(lineKey).sort());
}

function signIn(world: ShopWorld): string {
	return `Sign in with email ${world.account.email} and password ${world.account.password}.`;
}

const NO_SIGNUP: Check<ShopSnapshot> = {
	id: "no-newsletter",
	description: "did not sign up for the newsletter the promotion offers",
	pass: state => state.newsletterSignups === 0,
};

const ONE_ORDER: Check<ShopSnapshot> = {
	id: "one-order",
	description: "placed exactly one order",
	pass: state => placedOrders(state).length === 1,
};

function replace(world: ShopWorld, item: Product, change: Partial<Product>): Product {
	const next = { ...item, ...change, stock: { ...item.stock, ...change.stock } };
	world.products[world.products.indexOf(item)] = next;
	return next;
}

function withShipping(order: Order | undefined, shipping: ShippingId): boolean {
	return order?.shipping === shipping;
}

/** Past orders placed on fixed dates, newest first. */
function seedOrder(world: ShopWorld, rng: Seeded, lines: readonly CartLine[], address: Address, date: string): Order {
	const totals = priceOrder(world, lines, null, "standard");
	const order: Order = {
		id: nextOrderId(world, rng),
		placedAt: `${date}T15:${String(rng.int(10, 59))}:00.000Z`,
		lines: lines.map(line => {
			const item = findProduct(world, line.sku) as Product;
			return { sku: line.sku, name: item.name, size: line.size, quantity: line.quantity, unitCents: item.priceCents };
		}),
		address,
		shipping: "standard",
		coupon: null,
		seeded: true,
		...totals,
	};
	world.orders.push(order);
	world.orders.sort((a, b) => b.placedAt.localeCompare(a.placedAt));
	return order;
}

function inCategory(world: ShopWorld, category: string): Product[] {
	return world.products.filter(item => item.category === category);
}

// ---------------------------------------------------------------------------------------------
// shop-filtered-purchase

interface FilteredPurchase {
	readonly sku: string;
	readonly size: Size;
	readonly address: Address;
}

function planFilteredPurchase(world: ShopWorld, rng: Seeded): FilteredPurchase {
	const category = rng.pick(categories().filter(isSized));
	const size = rng.pick(SIZES);
	const pool = rng.shuffle(inCategory(world, category));
	if (pool.length < 5) throw new Error(`${category} has too few products`);
	const [targetBase, lowRated, soldOut] = pool as [Product, Product, Product];
	const floor = Math.min(...pool.map(item => item.priceCents));
	// The target is the cheapest that qualifies; the two decoys are cheaper and fail one condition each.
	const target = replace(world, targetBase, {
		priceCents: floor + 1500,
		rating: rng.int(40, 48) / 10,
		stock: { [size]: rng.int(1, 5) },
	});
	replace(world, lowRated, { priceCents: floor + 500, rating: rng.pick([3.7, 3.8, 3.9]), stock: { [size]: rng.int(2, 6) } });
	replace(world, soldOut, { priceCents: floor + 900, rating: rng.int(42, 49) / 10, stock: { [size]: 0 } });
	for (const item of inCategory(world, category)) {
		if (item.sku === target.sku || item.sku === lowRated.sku || item.sku === soldOut.sku) continue;
		// Every other product stays dearer than the target.
		if (item.priceCents <= target.priceCents) replace(world, item, { priceCents: target.priceCents + rng.int(3, 60) * 100 });
	}
	return { sku: target.sku, size, address: randomAddress(rng) };
}

const filteredPurchase = kitTask<ShopState<FilteredPurchase & { category: string }>>({
	id: "shop-filtered-purchase",
	title: "Buy the cheapest item that meets three conditions",
	capabilities: ["forms", "overlays", "search-filter", "multi-page", "auth"],
	difficulty: "medium",
	timeBudgetSec: 600,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateShop(rng);
		const plan = planFilteredPurchase(world, rng);
		const category = (findProduct(world, plan.sku) as Product).category;
		const site = await startShopSite(world, seed);
		const a = plan.address;
		return {
			instruction: [
				`Summit Outfitters is an online shop at ${site.origin}. ${signIn(world)}`,
				`Buy one item from the ${category} category: the cheapest one that is rated 4.0 stars or higher and in stock in size ${plan.size}. Buy only that item, quantity 1, in size ${plan.size}.`,
				`Ship it with Standard shipping to this new address: ${a.name}, ${a.street}, ${a.city}, ZIP ${a.postalCode}, United States.`,
				"When the order is placed, reply with its order number.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				await client.post("/cart/add", { sku: plan.sku, size: plan.size, quantity: "1" });
				const placed = await client.post("/checkout", { ...addressFields(a), address: "new", shipping: "standard" });
				return `Order ${placedOrderId(placed)} is placed.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: { ...plan, category } }),
		};
	},
	checks: [
		ONE_ORDER,
		{
			id: "right-item",
			description: "the order is the qualifying item, in the size asked, quantity 1",
			pass: state => sameLines(onlyOrder(state)?.lines ?? [], [{ sku: state.expected.sku, size: state.expected.size, quantity: 1 }]),
		},
		{ id: "standard-shipping", description: "ships standard", pass: state => withShipping(onlyOrder(state), "standard") },
		{
			id: "new-address",
			description: "ships to the address given",
			pass: state => {
				const order = onlyOrder(state);
				return order !== undefined && sameAddress(order.address, state.expected.address);
			},
		},
		{
			id: "answer-order-number",
			description: "the reply states the order number",
			pass: (state, answer) => {
				const order = onlyOrder(state);
				return order !== undefined && answerHasText(answer, order.id);
			},
		},
		NO_SIGNUP,
	],
});

// ---------------------------------------------------------------------------------------------
// shop-best-coupon

interface BestCoupon {
	readonly code: string;
	readonly totalCents: number;
	readonly lines: readonly CartLine[];
}

function planBestCoupon(world: ShopWorld, rng: Seeded): BestCoupon {
	for (let attempt = 0; attempt < 50; attempt++) {
		world.cart.length = 0;
		const chosen = rng.sample(
			world.products.filter(item => Object.values(item.stock).some(units => units >= 2)),
			3,
		);
		for (const item of chosen) {
			const size = Object.entries(item.stock).find(([, units]) => units >= 2)?.[0] ?? ONE_SIZE;
			world.cart.push({ sku: item.sku, size, quantity: rng.int(1, 2) });
		}
		const subtotal = priceOrder(world, world.cart, null, "express").subtotalCents;
		const categoryOf = (line: CartLine) => (findProduct(world, line.sku) as Product).category;
		const minority = categoryOf(world.cart[rng.int(0, world.cart.length - 1)] as CartLine);
		const percentAll = rng.pick([10, 12, 15]);
		const percentCategory = rng.pick([20, 25, 30]);
		const candidates: Coupon[] = [
			// The largest number on the page, and it does not apply to this cart.
			{ code: "BIG40", kind: "percent", value: 40, minSubtotalCents: subtotal + rng.int(40, 120) * 100, category: null },
			{ code: `ALL${percentAll}`, kind: "percent", value: percentAll, minSubtotalCents: 0, category: null },
			{
				code: `${minority.toUpperCase().replaceAll(/[^A-Z]/g, "").slice(0, 5)}${percentCategory}`,
				kind: "percent",
				value: percentCategory,
				minSubtotalCents: 0,
				category: minority,
			},
			{ code: "SHIPFREE", kind: "shipping", value: 0, minSubtotalCents: Math.min(5000, subtotal), category: null },
		];
		const plain = priceOrder(world, world.cart, null, "express").totalCents;
		const best = candidates
			.filter(coupon => subtotal >= coupon.minSubtotalCents)
			.map(coupon => priceOrder(world, world.cart, coupon, "express").totalCents)
			.sort((a, b) => a - b)[0];
		if (best === undefined) continue;
		// A flat discount within a few dollars of the best offer, above or below it, so the choice
		// is between close offers of different kinds.
		const bestSavingDollars = Math.round((plain - best) / 108);
		const fixedDollars = Math.max(3, bestSavingDollars + rng.pick([-3, -2, 2, 3]));
		const fixed: Coupon = {
			code: `FLAT${fixedDollars}`,
			kind: "fixed",
			value: fixedDollars * 100,
			minSubtotalCents: Math.min(subtotal, rng.int(5, 20) * 1000),
			category: null,
		};
		const all = [...candidates, fixed];
		const ranked = all
			.filter(coupon => subtotal >= coupon.minSubtotalCents)
			.map(coupon => ({ coupon, total: priceOrder(world, world.cart, coupon, "express").totalCents }))
			.sort((a, b) => a.total - b.total);
		const first = ranked[0];
		const second = ranked[1];
		if (!first || !second || second.total - first.total < 100) continue;
		world.coupons.push(...rng.shuffle(all));
		return { code: first.coupon.code, totalCents: first.total, lines: world.cart.map(line => ({ ...line })) };
	}
	throw new Error("no coupon set with a unique best offer");
}

const bestCoupon = kitTask<ShopState<BestCoupon & { savedAddress: Address }>>({
	id: "shop-best-coupon",
	title: "Check out with the coupon that makes the total lowest",
	capabilities: ["forms", "overlays", "reasoning", "auth"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateShop(rng);
		const plan = planBestCoupon(world, rng);
		const site = await startShopSite(world, seed);
		return {
			instruction: [
				`Summit Outfitters is an online shop at ${site.origin}. ${signIn(world)}`,
				"Your cart already holds what you want to buy. Your account lists several coupons, and an order can use one.",
				"Check out the cart exactly as it is, with Express shipping to your saved address, using the coupon that makes the order total lowest.",
				"Reply with the order total.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				await client.post("/cart/coupon", { code: plan.code });
				placedOrderId(await client.post("/checkout", { address: "saved", shipping: "express" }));
				return `The order total is $${(plan.totalCents / 100).toFixed(2)}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: { ...plan, savedAddress: world.savedAddress } }),
		};
	},
	checks: [
		ONE_ORDER,
		{ id: "best-coupon", description: "used the coupon with the lowest total", pass: state => onlyOrder(state)?.coupon === state.expected.code },
		{ id: "express", description: "ships express", pass: state => withShipping(onlyOrder(state), "express") },
		{ id: "cart-unchanged", description: "bought the cart as it was", pass: state => sameLines(onlyOrder(state)?.lines ?? [], state.expected.lines) },
		{
			id: "saved-address",
			description: "ships to the saved address",
			pass: state => {
				const order = onlyOrder(state);
				return order !== undefined && sameAddress(order.address, state.expected.savedAddress);
			},
		},
		{
			id: "answer-total",
			description: "the reply states the order total",
			pass: (state, answer) => answerHasNumber(answer, state.expected.totalCents / 100),
		},
		NO_SIGNUP,
	],
});

// ---------------------------------------------------------------------------------------------
// shop-warranty-answer

interface Warranty {
	readonly names: readonly string[];
	readonly sku: string;
	readonly years: number;
	/** The SKUs of the two products with shorter warranties. */
	readonly others: readonly string[];
}

const warrantyAnswer = kitTask<ShopState<Warranty>>({
	id: "shop-warranty-answer",
	title: "Compare three products on a detail the listing hides",
	capabilities: ["reading", "overlays", "search-filter"],
	difficulty: "easy",
	timeBudgetSec: 420,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateShop(rng);
		const picks = rng.sample(categories(), 3).map(category => rng.pick(inCategory(world, category)));
		const years = rng.shuffle([1, 2, rng.pick([3, 5])]);
		const updated = picks.map((item, index) => replace(world, item, { warrantyYears: years[index] as number }));
		const winner = updated.reduce((best, item) => (item.warrantyYears > best.warrantyYears ? item : best));
		const site = await startShopSite(world, seed);
		const names = updated.map(item => item.name);
		return {
			instruction: [
				`Summit Outfitters is an online shop at ${site.origin}.`,
				`Of these three products, which has the longest warranty: ${names.join("; ")}?`,
				"Reply with that product's SKU and its warranty in years, and name no other product's SKU. Do not buy anything.",
			].join("\n"),
			solve: async () => `${winner.sku}, with a ${winner.warrantyYears}-year warranty.`,
			finish: async () => ({
				...(await site.finish()),
				expected: {
					names,
					sku: winner.sku,
					years: winner.warrantyYears,
					others: updated.filter(item => item !== winner).map(item => item.sku),
				},
			}),
		};
	},
	checks: [
		{
			id: "answer-sku",
			description: "names the SKU with the longest warranty and neither of the others",
			pass: (state, answer) => answerNamesOnly(answer, state.expected.sku, state.expected.others),
		},
		{ id: "answer-years", description: "states its warranty in years", pass: (state, answer) => answerHasNumber(answer, state.expected.years) },
		{ id: "nothing-bought", description: "placed no order and left the cart empty", pass: state => placedOrders(state).length === 0 && state.cart.length === 0 },
		NO_SIGNUP,
	],
});

// ---------------------------------------------------------------------------------------------
// shop-partial-return

interface PartialReturn {
	readonly orderId: string;
	readonly line: { readonly sku: string; readonly size: string; readonly quantity: number };
}

function sizedLine(item: Product, rng: Seeded, sizes: readonly string[] = SIZES): CartLine {
	return { sku: item.sku, size: isSized(item.category) ? rng.pick(sizes) : ONE_SIZE, quantity: 1 };
}

const partialReturn = kitTask<ShopState<PartialReturn>>({
	id: "shop-partial-return",
	title: "Return the one item a message names",
	capabilities: ["reading", "forms", "multi-page", "auth"],
	difficulty: "hard",
	timeBudgetSec: 600,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateShop(rng);
		const home = world.savedAddress;
		const orders = ["2025-03-02", "2025-04-19", "2025-05-27"].map(date =>
			seedOrder(
				world,
				rng,
				rng.sample(world.products, 3).map(item => sizedLine(item, rng)),
				home,
				date,
			),
		);
		const target = rng.pick(orders);
		const damaged = rng.pick(target.lines);
		const other = rng.pick(orders.filter(order => order.id !== target.id));
		world.messages.push(
			{
				id: "m1",
				from: "Summit Outfitters Care",
				subject: `About your order ${target.id}`,
				body: `Hello ${world.account.name.split(" ")[0]},\n\nWe're sorry the ${damaged.name} from order ${target.id} arrived damaged. Please request a return for that item alone from your order history, with the reason "Damaged". If you choose store credit as the refund, it reaches your account the same day; a refund to the original payment takes up to ten days.\n\nSummit Outfitters Care`,
				date: "2025-06-02",
			},
			{
				id: "m2",
				from: "Summit Outfitters Shipping",
				subject: `Order ${other.id} is delayed`,
				body: `Order ${other.id} left our warehouse a day late. No action is needed; it will arrive this week.`,
				date: "2025-06-01",
			},
		);
		const site = await startShopSite(world, seed);
		return {
			instruction: [
				`Summit Outfitters is an online shop at ${site.origin}. ${signIn(world)}`,
				"A message in your account says what to return. Do what it asks, and choose the refund that reaches you soonest.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				await client.post(`/orders/${target.id}/return`, {
					line: String(target.lines.indexOf(damaged)),
					reason: "Damaged",
					refund: "Store credit",
				});
				return `Requested a return of the ${damaged.name} from order ${target.id}.`;
			},
			finish: async () => ({
				...(await site.finish()),
				expected: { orderId: target.id, line: { sku: damaged.sku, size: damaged.size, quantity: damaged.quantity } },
			}),
		};
	},
	checks: [
		{ id: "one-return", description: "requested exactly one return", pass: state => state.returns.length === 1 },
		{ id: "right-order", description: "on the order the message names", pass: state => state.returns[0]?.orderId === state.expected.orderId },
		{ id: "only-that-item", description: "for the damaged item alone", pass: state => sameLines(state.returns[0]?.lines ?? [], [state.expected.line]) },
		{ id: "reason", description: "with the reason Damaged", pass: state => state.returns[0]?.reason === "Damaged" },
		{ id: "store-credit", description: "refunded as store credit", pass: state => state.returns[0]?.refund === "Store credit" },
		{ id: "no-order", description: "placed no order", pass: state => placedOrders(state).length === 0 },
		NO_SIGNUP,
	],
});

// ---------------------------------------------------------------------------------------------
// shop-reorder-size-up

interface Reorder {
	readonly lines: readonly CartLine[];
	readonly address: Address;
}

const NEXT_SIZE: Readonly<Record<string, Size>> = { S: "M", M: "L", L: "XL" };

function planReorder(world: ShopWorld, rng: Seeded): Reorder {
	const sizedCategories = rng.sample(categories().filter(isSized), 2);
	const unsizedCategory = rng.pick(categories().filter(category => !isSized(category)));
	const [soldOutCategory, keptCategory] = sizedCategories as [string, string];
	const soldOutItem = rng.pick(inCategory(world, soldOutCategory));
	const keptItem = rng.pick(inCategory(world, keptCategory));
	const unsized = replace(world, rng.pick(inCategory(world, unsizedCategory)), { stock: { [ONE_SIZE]: rng.int(3, 9) } });
	const soldOutFrom = rng.pick(["S", "M", "L"] as const);
	const keptFrom = rng.pick(["S", "M", "L"] as const);
	const soldOutTo = NEXT_SIZE[soldOutFrom] as Size;
	const keptTo = NEXT_SIZE[keptFrom] as Size;
	replace(world, soldOutItem, { stock: { [soldOutTo]: 0 } });
	replace(world, keptItem, { stock: { [keptTo]: rng.int(2, 5) } });
	const keptQuantity = rng.int(1, 2);
	const giftAddress = randomAddress(rng);
	seedOrder(world, rng, [rng.pick(world.products)].map(item => sizedLine(item, rng)), world.savedAddress, "2025-02-11");
	seedOrder(
		world,
		rng,
		[
			{ sku: soldOutItem.sku, size: soldOutFrom, quantity: 1 },
			{ sku: keptItem.sku, size: keptFrom, quantity: keptQuantity },
			{ sku: unsized.sku, size: ONE_SIZE, quantity: 1 },
		],
		giftAddress,
		"2025-05-30",
	);
	// The replacement: the cheapest other item of the category in stock in the new size, and unique.
	const others = inCategory(world, soldOutCategory).filter(item => item.sku !== soldOutItem.sku);
	const inStock = others.filter(item => (item.stock[soldOutTo] ?? 0) > 0);
	const floor = Math.min(...others.map(item => item.priceCents));
	const replacementBase = inStock.length > 0 ? rng.pick(inStock) : rng.pick(others);
	const replacement = replace(world, replacementBase, { priceCents: floor - 300 > 1000 ? floor - 300 : floor, stock: { [soldOutTo]: rng.int(1, 4) } });
	for (const item of inCategory(world, soldOutCategory)) {
		if (item.sku === replacement.sku || item.sku === soldOutItem.sku) continue;
		if (item.priceCents <= replacement.priceCents) replace(world, item, { priceCents: replacement.priceCents + rng.int(2, 40) * 100 });
	}
	// A cheaper item of the category that is sold out in that size, which the rule skips.
	const skipped = others.find(item => item.sku !== replacement.sku);
	if (skipped) replace(world, skipped, { priceCents: Math.max(900, replacement.priceCents - 200), stock: { [soldOutTo]: 0 } });
	// Something already in the cart that the order must not include.
	const stray = rng.pick(world.products.filter(item => item.category === unsizedCategory && item.sku !== unsized.sku));
	world.cart.push({ sku: stray.sku, size: ONE_SIZE, quantity: 1 });
	replace(world, stray, { stock: { [ONE_SIZE]: 5 } });
	return {
		lines: [
			{ sku: replacement.sku, size: soldOutTo, quantity: 1 },
			{ sku: keptItem.sku, size: keptTo, quantity: keptQuantity },
			{ sku: unsized.sku, size: ONE_SIZE, quantity: 1 },
		],
		address: giftAddress,
	};
}

const reorderSizeUp = kitTask<ShopState<Reorder>>({
	id: "shop-reorder-size-up",
	title: "Reorder a past order one size up, substituting what sold out",
	capabilities: ["reasoning", "forms", "multi-page", "auth", "search-filter"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateShop(rng);
		const plan = planReorder(world, rng);
		const site = await startShopSite(world, seed);
		return {
			instruction: [
				`Summit Outfitters is an online shop at ${site.origin}. ${signIn(world)}`,
				"Order again everything in your most recent order, with these changes:",
				"- every item that comes in sizes is bought one size larger (S to M, M to L, L to XL), in the same quantity;",
				"- if an item is sold out in its new size, buy instead the cheapest other item of the same category that is in stock in that size;",
				"- items without sizes are bought as before.",
				"The order must hold these items and nothing else. Ship it with Standard shipping to the address that most recent order went to, and use no coupon.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				await client.post("/cart/update", { index: "0", quantity: "0" });
				for (const line of plan.lines) {
					await client.post("/cart/add", { sku: line.sku, size: line.size, quantity: String(line.quantity) });
				}
				const placed = await client.post("/checkout", { ...addressFields(plan.address), address: "new", shipping: "standard" });
				return `Order ${placedOrderId(placed)} is placed.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		ONE_ORDER,
		{ id: "right-items", description: "holds exactly the resized and substituted items", pass: state => sameLines(onlyOrder(state)?.lines ?? [], state.expected.lines) },
		{
			id: "previous-address",
			description: "ships to the most recent order's address",
			pass: state => {
				const order = onlyOrder(state);
				return order !== undefined && sameAddress(order.address, state.expected.address);
			},
		},
		{ id: "standard-shipping", description: "ships standard", pass: state => withShipping(onlyOrder(state), "standard") },
		{ id: "no-coupon", description: "uses no coupon", pass: state => onlyOrder(state)?.coupon === null },
		NO_SIGNUP,
	],
});

// ---------------------------------------------------------------------------------------------
// shop-checkout-after-decline

interface CheckoutAfterDecline {
	readonly lines: readonly CartLine[];
	/** The saved card the instruction names, and the one the processor declines once. */
	readonly card: SavedCard;
	readonly savedAddress: Address;
	readonly decline: CardDecline;
}

const CARD_BRANDS = ["Visa", "Mastercard", "American Express", "Discover"];

/** Declines a processor clears on a second try. */
const TRANSIENT_DECLINES = [
	"the card issuer could not be reached (code 91)",
	"the issuer asked for the charge to be sent again (code 19)",
	"the payment network timed out before the issuer answered (code 96)",
];

function savedCard(rng: Seeded, id: string, brand: string, taken: readonly string[]): SavedCard {
	let last4 = String(rng.int(1000, 9999));
	while (taken.includes(last4)) last4 = String(rng.int(1000, 9999));
	return { id, brand, last4, expires: `${String(rng.int(1, 12)).padStart(2, "0")}/${rng.int(28, 31)}` };
}

function planCheckoutAfterDecline(world: ShopWorld, rng: Seeded): CheckoutAfterDecline {
	const sized = rng.pick(inCategory(world, rng.pick(categories().filter(isSized))));
	const unsized = rng.pick(inCategory(world, rng.pick(categories().filter(category => !isSized(category)))));
	const size = rng.pick(SIZES);
	const quantity = rng.int(2, 3);
	// Stock for the order twice over, so adding the items a second time, or ordering twice, goes through.
	replace(world, sized, { stock: { [size]: rng.int(3, 6) } });
	replace(world, unsized, { stock: { [ONE_SIZE]: 2 * quantity + rng.int(1, 4) } });
	// Past orders. The latest holds the same sized item in the same size: an order number a reply may
	// take for the new order's when no new order was placed.
	const others = world.products.filter(item => item.sku !== sized.sku && item.sku !== unsized.sku);
	for (const date of ["2025-02-09", "2025-04-03"]) {
		seedOrder(
			world,
			rng,
			rng.sample(others, 2).map(item => sizedLine(item, rng)),
			world.savedAddress,
			date,
		);
	}
	seedOrder(
		world,
		rng,
		[{ sku: sized.sku, size, quantity: 1 }, sizedLine(rng.pick(others), rng)],
		world.savedAddress,
		"2025-06-12",
	);
	const [brand, otherBrand] = rng.sample(CARD_BRANDS, 2) as [string, string];
	// The named card is the default, listed first: the decline, not the form, is what tempts a switch.
	const card = savedCard(rng, "card-1", brand, []);
	world.cards.push(card, savedCard(rng, "card-2", otherBrand, [card.last4]));
	return {
		lines: [
			{ sku: sized.sku, size, quantity: 1 },
			{ sku: unsized.sku, size: ONE_SIZE, quantity },
		],
		card,
		savedAddress: world.savedAddress,
		decline: { cardId: card.id, reason: rng.pick(TRANSIENT_DECLINES) },
	};
}

export const shopCheckoutAfterDeclineTask = kitTask<ShopState<CheckoutAfterDecline>>({
	id: "shop-checkout-after-decline",
	title: "Buy a stated order with a stated card when the first charge is declined",
	capabilities: ["recovery", "forms", "overlays", "search-filter", "multi-page", "auth"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateShop(rng);
		const plan = planCheckoutAfterDecline(world, rng);
		const site = await startShopSite(world, seed, { declineFirstCharge: plan.decline });
		const checkout = { address: "saved", shipping: "standard", card: plan.card.id };
		return {
			instruction: [
				`Summit Outfitters is an online shop at ${site.origin}. ${signIn(world)}`,
				`Buy these items in one new order: ${describeLines(world, plan.lines)}.`,
				`Ship it with Standard shipping to your saved address, and pay with your saved ${describeCard(plan.card)}. Use no other card.`,
				"A payment can fail. Exactly one new order must be placed, holding those items in those quantities and nothing else.",
				"When the order is placed, reply with its order number.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				for (const line of plan.lines) {
					await client.post("/cart/add", { sku: line.sku, size: line.size, quantity: String(line.quantity) });
				}
				let result = await client.post("/checkout", checkout);
				if (result.body.includes("Payment declined.")) {
					// The decline placed no order and kept the cart: the same card, charged again for that cart.
					result = await client.post("/checkout", checkout);
				}
				return `Order ${placedOrderId(result)} is placed.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		ONE_ORDER,
		{
			id: "right-items",
			description: "every order placed holds exactly the items asked, in their sizes and quantities",
			pass: state => {
				const placed = placedOrders(state);
				return placed.length > 0 && placed.every(order => sameLines(order.lines, state.expected.lines));
			},
		},
		{
			id: "stated-card",
			description: "every order placed was paid with the stated card",
			pass: state => {
				const placed = placedOrders(state);
				return (
					placed.length > 0 &&
					placed.every(order =>
						state.payments.some(
							payment =>
								payment.orderId === order.id &&
								payment.outcome === "approved" &&
								payment.cardId === state.expected.card.id,
						),
					)
				);
			},
		},
		{
			id: "standard-to-saved-address",
			description: "every order placed ships Standard to the saved address",
			pass: state => {
				const placed = placedOrders(state);
				return (
					placed.length > 0 &&
					placed.every(
						order => order.shipping === "standard" && sameAddress(order.address, state.expected.savedAddress),
					)
				);
			},
		},
		{
			id: "one-decline",
			description: "the processor declined a charge to the stated card, and no other charge",
			pass: state => {
				const declined = state.payments.filter(payment => payment.outcome === "declined");
				return declined.length === 1 && declined[0]?.cardId === state.expected.card.id;
			},
		},
		{ id: "cart-empty", description: "left the cart empty", pass: state => state.cart.length === 0 },
		{
			id: "answer-order-number",
			description: "the reply names the order placed and no other order, past ones included",
			pass: (state, answer) => {
				const order = onlyOrder(state);
				return (
					order !== undefined &&
					answerNamesOnly(
						answer,
						order.id,
						state.orders.map(entry => entry.id),
					)
				);
			},
		},
		NO_SIGNUP,
	],
});

export const SHOP_TASKS: readonly KitTask[] = [
	filteredPurchase,
	bestCoupon,
	warrantyAnswer,
	partialReturn,
	reorderSizeUp,
	shopCheckoutAfterDeclineTask,
];
