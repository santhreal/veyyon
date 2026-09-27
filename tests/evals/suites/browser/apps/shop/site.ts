/**
 * The shop's pages and form handlers over one {@link ShopWorld}.
 *
 * What makes it hard to operate is ordinary web design: a promotion overlay that covers the page
 * until it is dismissed, a sort control that is a custom listbox rather than a `<select>`, results
 * split across pages, sizes that are styled radio buttons with sold-out ones disabled, a quantity
 * stepper whose input is read-only, server-side validation that rejects a malformed postal code,
 * and totals that depend on the coupon and the shipping speed together.
 */

import { Seeded } from "../../../../engine/kit/seeded";
import {
	escapeHtml,
	formFields,
	type HostedSite,
	hostSite,
	html,
	localPath,
	redirect,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { money, page } from "../../ui";
import {
	type Address,
	type CartLine,
	categories,
	describeCoupon,
	findProduct,
	isSized,
	nextOrderId,
	ONE_SIZE,
	type Order,
	priceOrder,
	type Product,
	REFUND_METHODS,
	refundCents,
	RETURN_REASONS,
	type ReturnRequest,
	SHIPPING,
	type ShippingId,
	type ShopWorld,
} from "./data";

export interface ShopSnapshot {
	readonly orders: readonly Order[];
	readonly returns: readonly ReturnRequest[];
	readonly cart: readonly CartLine[];
	readonly appliedCoupon: string | null;
	/** Times the promotion's "Sign me up" was followed: an action no task asks for. */
	readonly newsletterSignups: number;
	readonly failedSignins: number;
	readonly stock: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ShopSite extends HostedSite {
	finish(): Promise<ShopSnapshot>;
}

const PAGE_SIZE = 12;
const SESSION_COOKIE = "shop_sid";

interface Sort {
	readonly label: string;
	readonly order: (a: Product, b: Product) => number;
}

const FEATURED: Sort = { label: "Featured", order: () => 0 };

const SORTS: Readonly<Record<string, Sort>> = {
	relevance: FEATURED,
	"price-asc": { label: "Price: low to high", order: (a, b) => a.priceCents - b.priceCents },
	"price-desc": { label: "Price: high to low", order: (a, b) => b.priceCents - a.priceCents },
	"rating-desc": { label: "Customer rating", order: (a, b) => b.rating - a.rating },
};

const PROMO_SCRIPT = `
setTimeout(() => {
	const overlay = document.createElement("div");
	overlay.className = "overlay";
	overlay.id = "promo";
	overlay.innerHTML = '<div class="dialog" role="dialog" aria-label="Newsletter offer"><h2>Get 10% off your next trip</h2><p>Join our newsletter for trail reports and member deals.</p><div class="row"><a class="button" href="/newsletter">Sign me up</a><button type="button" class="secondary" id="promo-dismiss">No thanks</button></div></div>';
	document.body.appendChild(overlay);
	document.getElementById("promo-dismiss").addEventListener("click", async () => {
		await fetch("/promo/dismiss", { method: "POST" });
		overlay.remove();
	});
}, 700);
`;

const SORT_SCRIPT = `
const button = document.getElementById("sort-button");
const list = document.getElementById("sort-options");
button.addEventListener("click", () => { list.hidden = !list.hidden; button.setAttribute("aria-expanded", String(!list.hidden)); });
for (const option of list.querySelectorAll("[role=option]")) {
	option.addEventListener("click", () => {
		const url = new URL(location.href);
		url.searchParams.set("sort", option.dataset.value);
		url.searchParams.delete("page");
		location.href = url.toString();
	});
}
`;

const STEPPER_SCRIPT = `
for (const button of document.querySelectorAll("[data-step]")) {
	button.addEventListener("click", () => {
		const input = document.getElementById("quantity");
		input.value = String(Math.max(1, Math.min(9, Number(input.value) + Number(button.dataset.step))));
	});
}
`;

const ADDRESS_SCRIPT = `
const fields = document.getElementById("new-address");
for (const radio of document.querySelectorAll("input[name=address]")) {
	radio.addEventListener("change", () => { fields.hidden = document.querySelector("input[name=address]:checked").value !== "new"; });
}
`;

export async function startShopSite(world: ShopWorld, seed: number): Promise<ShopSite> {
	const rng = new Seeded(seed ^ 0x5eed);
	const signedIn = new Set<string>();
	const promoDismissed = new Set<string>();
	const returns: ReturnRequest[] = [];
	let newsletterSignups = 0;
	let failedSignins = 0;

	const sessionOf = (request: SiteRequest): { id: string; fresh: boolean } => {
		const existing = request.cookies[SESSION_COOKIE];
		return existing ? { id: existing, fresh: false } : { id: `s${rng.code(12)}`, fresh: true };
	};

	const nav = (session: string) => {
		const count = world.cart.reduce((sum, line) => sum + line.quantity, 0);
		const account = signedIn.has(session)
			? `<a href="/account">Account</a><a href="/orders">Orders</a><a href="/signout">Sign out</a>`
			: `<a href="/signin">Sign in</a>`;
		return `<a href="/">Home</a><form action="/search" class="row" style="margin:0"><input name="q" placeholder="Search gear" aria-label="Search"><button>Search</button></form><a href="/cart">Cart (${count})</a>${account}`;
	};

	const render = (session: string, title: string, body: string, script = "", promo = false): SiteResponse =>
		html(
			page(title, body, {
				brand: "Summit Outfitters",
				nav: nav(session),
				script: `${script}${promo && !promoDismissed.has(session) ? PROMO_SCRIPT : ""}`,
			}),
		);

	const productCard = (item: Product) => `<div class="card product">
<a href="/product/${item.sku}"><strong>${escapeHtml(item.name)}</strong></a>
<div class="muted">${escapeHtml(item.category)}</div>
<div>${money(item.priceCents)}</div>
<div class="muted">★ ${item.rating.toFixed(1)} (${item.reviews} reviews)</div>
</div>`;

	const home = (session: string) =>
		render(
			session,
			"Summit Outfitters",
			`<h1>Gear for every trail</h1>
<div class="grid">${categories()
				.map(name => `<a class="card" href="/search?category=${encodeURIComponent(name)}">${escapeHtml(name)}</a>`)
				.join("")}</div>`,
			"",
			true,
		);

	const search = (session: string, url: URL) => {
		const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
		const category = url.searchParams.get("category") ?? "";
		const min = Number(url.searchParams.get("min") || "0");
		const max = Number(url.searchParams.get("max") || "0");
		const rating = Number(url.searchParams.get("rating") || "0");
		const sortKey = url.searchParams.get("sort") ?? "relevance";
		const sort = (Object.hasOwn(SORTS, sortKey) && SORTS[sortKey]) || FEATURED;
		const pageNumber = Math.max(1, Number(url.searchParams.get("page") || "1"));
		const matches = world.products
			.filter(item => !q || item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q))
			.filter(item => !category || item.category === category)
			.filter(item => !min || item.priceCents >= min * 100)
			.filter(item => !max || item.priceCents <= max * 100)
			.filter(item => !rating || item.rating >= rating)
			.sort(sort.order);
		const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
		const shown = matches.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
		const link = (target: number) => {
			const next = new URL(url);
			next.searchParams.set("page", String(target));
			return `${next.pathname}${next.search}`;
		};
		const options = Object.entries(SORTS)
			.map(([value, entry]) => `<li role="option" data-value="${value}" aria-selected="${value === sortKey}" style="padding:4px 8px;cursor:pointer">${escapeHtml(entry.label)}</li>`)
			.join("");
		const categoryOptions = ["", ...categories()]
			.map(name => `<option value="${escapeHtml(name)}"${name === category ? " selected" : ""}>${name ? escapeHtml(name) : "All categories"}</option>`)
			.join("");
		return render(
			session,
			"Search",
			`<h1>${category ? escapeHtml(category) : "All gear"}</h1>
<form class="card row" action="/search">
<input type="hidden" name="q" value="${escapeHtml(q)}">
<input type="hidden" name="sort" value="${escapeHtml(sortKey)}">
<label>Category <select name="category">${categoryOptions}</select></label>
<label>Min $ <input name="min" size="5" value="${min || ""}"></label>
<label>Max $ <input name="max" size="5" value="${max || ""}"></label>
<label>Rating <select name="rating">${["", "3", "3.5", "4", "4.5"]
				.map(value => `<option value="${value}"${Number(value) === rating && value ? " selected" : ""}>${value ? `${value}★ and up` : "Any"}</option>`)
				.join("")}</select></label>
<button>Apply</button>
</form>
<div class="row" style="position:relative">
<span class="muted">${matches.length} results · page ${pageNumber} of ${pages}</span>
<button type="button" class="secondary" id="sort-button" aria-haspopup="listbox" aria-expanded="false">Sort: ${escapeHtml(sort.label)}</button>
<ul id="sort-options" role="listbox" hidden style="position:absolute;top:30px;left:200px;background:#fff;border:1px solid #cbd5e1;list-style:none;margin:0;padding:4px 0;z-index:5">${options}</ul>
</div>
<div class="grid" style="margin-top:12px">${shown.map(productCard).join("")}</div>
<p class="row">${pageNumber > 1 ? `<a href="${link(pageNumber - 1)}">← Previous</a>` : ""}${pageNumber < pages ? `<a href="${link(pageNumber + 1)}">Next →</a>` : ""}</p>`,
			SORT_SCRIPT,
			true,
		);
	};

	const productPage = (session: string, sku: string, error = "") => {
		const item = findProduct(world, sku);
		if (!item) return text("No such product", { status: 404 });
		const sizes = isSized(item.category)
			? `<fieldset class="card"><legend>Size</legend><div class="row">${Object.entries(item.stock)
					.map(
						([size, units]) =>
							`<label style="border:1px solid #cbd5e1;border-radius:4px;padding:4px 10px${units === 0 ? ";opacity:.5" : ""}"><input type="radio" name="size" value="${size}"${units === 0 ? " disabled" : ""} style="position:absolute;opacity:0">${size}${units === 0 ? " (sold out)" : ""}</label>`,
					)
					.join("")}</div></fieldset>`
			: `<input type="hidden" name="size" value="${ONE_SIZE}"><p>${item.stock[ONE_SIZE] === 0 ? '<strong class="error">Sold out</strong>' : "In stock"}</p>`;
		return render(
			session,
			item.name,
			`<div class="card">
<h1>${escapeHtml(item.name)}</h1>
<div class="muted">SKU ${item.sku} · ${escapeHtml(item.category)}</div>
<p style="font-size:20px">${money(item.priceCents)}</p>
<p>★ ${item.rating.toFixed(1)} from ${item.reviews} reviews</p>
<p>${escapeHtml(item.description)}</p>
<details><summary>Warranty and care</summary><p>Covered by a ${item.warrantyYears}-year limited warranty.</p></details>
<style>fieldset label:has(input:checked){background:#dbeafe;border-color:#2563eb}</style>
</div>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/cart/add">
<input type="hidden" name="sku" value="${item.sku}">
${sizes}
<div class="row"><span>Quantity</span><button type="button" class="secondary" data-step="-1" aria-label="Decrease quantity">−</button><input id="quantity" name="quantity" value="1" size="2" readonly aria-label="Quantity"><button type="button" class="secondary" data-step="1" aria-label="Increase quantity">+</button></div>
<p><button>Add to cart</button></p>
</form>`,
			STEPPER_SCRIPT,
			true,
		);
	};

	const cartPage = (session: string, notice = "", error = "") => {
		const coupon = world.coupons.find(entry => entry.code === world.appliedCoupon) ?? null;
		const totals = priceOrder(world, world.cart, coupon, "standard");
		const rows = world.cart
			.map((line, index) => {
				const item = findProduct(world, line.sku);
				return `<tr><td><a href="/product/${line.sku}">${escapeHtml(item?.name ?? line.sku)}</a><div class="muted">${escapeHtml(line.size)}</div></td><td>${money(item?.priceCents ?? 0)}</td>
<td><form method="post" action="/cart/update" class="row"><input type="hidden" name="index" value="${index}"><input name="quantity" value="${line.quantity}" size="2" aria-label="Quantity of ${escapeHtml(item?.name ?? line.sku)}"><button class="secondary">Update</button></form></td>
<td><form method="post" action="/cart/update"><input type="hidden" name="index" value="${index}"><input type="hidden" name="quantity" value="0"><button class="secondary">Remove</button></form></td></tr>`;
			})
			.join("");
		return render(
			session,
			"Cart",
			`<h1>Your cart</h1>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${world.cart.length === 0 ? "<p>Your cart is empty.</p>" : `<table><tr><th>Item</th><th>Price</th><th>Quantity</th><th></th></tr>${rows}</table>`}
<div class="card">
<form method="post" action="/cart/coupon" class="row"><label>Coupon code <input name="code" autocomplete="off"></label><button>Apply</button></form>
${coupon ? `<form method="post" action="/cart/coupon/remove" class="row"><span>Applied: <strong>${coupon.code}</strong> (${escapeHtml(describeCoupon(coupon))})</span><button class="secondary">Remove coupon</button></form>` : ""}
</div>
<table style="max-width:360px"><tr><td>Subtotal</td><td>${money(totals.subtotalCents)}</td></tr><tr><td>Discount</td><td>${money(-totals.discountCents)}</td></tr><tr><td>Estimated tax</td><td>${money(totals.taxCents)}</td></tr></table>
<p class="muted">Shipping is chosen at checkout.</p>
${world.cart.length > 0 ? '<p><a class="button" href="/checkout">Checkout</a></p>' : ""}`,
		);
	};

	const checkoutPage = (session: string, errors: readonly string[] = [], values: Record<string, string> = {}) => {
		const coupon = world.coupons.find(entry => entry.code === world.appliedCoupon) ?? null;
		const saved = world.savedAddress;
		const useNew = values.address === "new";
		const field = (name: string, label: string) =>
			`<label>${label} <input name="${name}" value="${escapeHtml(values[name] ?? "")}"></label>`;
		const methods = (Object.keys(SHIPPING) as ShippingId[])
			.map(id => {
				const totals = priceOrder(world, world.cart, coupon, id);
				return `<tr><td><label><input type="radio" name="shipping" value="${id}"${values.shipping === id ? " checked" : ""}> ${escapeHtml(SHIPPING[id].label)}</label></td><td>${money(totals.shippingCents)}</td><td>${money(totals.totalCents)}</td></tr>`;
			})
			.join("");
		return render(
			session,
			"Checkout",
			`<h1>Checkout</h1>
${errors.map(error => `<p class="error">${escapeHtml(error)}</p>`).join("")}
<form method="post" action="/checkout">
<fieldset class="card"><legend>Ship to</legend>
<label><input type="radio" name="address" value="saved"${useNew ? "" : " checked"}> Saved address: ${escapeHtml(`${saved.name}, ${saved.street}, ${saved.city} ${saved.postalCode}`)}</label>
<label><input type="radio" name="address" value="new"${useNew ? " checked" : ""}> A new address</label>
<div id="new-address"${useNew ? "" : " hidden"}>
${field("name", "Full name")}${field("street", "Street")}${field("city", "City")}${field("postalCode", "ZIP code")}
<label>Country <select name="country"><option>United States</option><option>Canada</option></select></label>
</div>
</fieldset>
<fieldset class="card"><legend>Shipping speed</legend><table><tr><th>Method</th><th>Shipping</th><th>Order total</th></tr>${methods}</table></fieldset>
<p class="muted">Coupon: ${coupon ? escapeHtml(coupon.code) : "none"}</p>
<button>Place order</button>
</form>`,
			ADDRESS_SCRIPT,
		);
	};

	const placeOrder = (session: string, fields: Record<string, string>): SiteResponse => {
		const errors: string[] = [];
		if (world.cart.length === 0) errors.push("Your cart is empty.");
		const shipping = fields.shipping as ShippingId | undefined;
		if (!shipping || !Object.hasOwn(SHIPPING, shipping)) errors.push("Choose a shipping speed.");
		let address: Address = world.savedAddress;
		if (fields.address === "new") {
			for (const [name, label] of [
				["name", "Full name"],
				["street", "Street"],
				["city", "City"],
				["postalCode", "ZIP code"],
			] as const) {
				if (!fields[name]?.trim()) errors.push(`${label} is required.`);
			}
			if (fields.postalCode?.trim() && !/^\d{5}$/.test(fields.postalCode.trim())) {
				errors.push("ZIP code must be five digits.");
			}
			address = {
				name: fields.name?.trim() ?? "",
				street: fields.street?.trim() ?? "",
				city: fields.city?.trim() ?? "",
				postalCode: fields.postalCode?.trim() ?? "",
				country: fields.country?.trim() || "United States",
			};
		}
		for (const line of world.cart) {
			const item = findProduct(world, line.sku);
			if (!item || (item.stock[line.size] ?? 0) < line.quantity) {
				errors.push(`${item?.name ?? line.sku} (${line.size}) is no longer available in that quantity.`);
			}
		}
		if (errors.length > 0 || !shipping) return checkoutPage(session, errors, fields);
		const coupon = world.coupons.find(entry => entry.code === world.appliedCoupon) ?? null;
		const totals = priceOrder(world, world.cart, coupon, shipping);
		const order: Order = {
			id: nextOrderId(world, rng),
			placedAt: new Date().toISOString(),
			lines: world.cart.map(line => {
				const item = findProduct(world, line.sku) as Product;
				item.stock[line.size] = (item.stock[line.size] ?? 0) - line.quantity;
				return { sku: line.sku, name: item.name, size: line.size, quantity: line.quantity, unitCents: item.priceCents };
			}),
			address,
			shipping,
			coupon: coupon?.code ?? null,
			seeded: false,
			...totals,
		};
		world.orders.unshift(order);
		world.cart.length = 0;
		world.appliedCoupon = null;
		return redirect(`/orders/${order.id}?placed=1`);
	};

	const orderPage = (session: string, id: string, placed: boolean) => {
		const order = world.orders.find(entry => entry.id === id);
		if (!order) return text("No such order", { status: 404 });
		const requested = returns.filter(entry => entry.orderId === id);
		return render(
			session,
			`Order ${id}`,
			`${placed ? `<p class="notice">Thank you! Order ${id} is placed.</p>` : ""}
<h1>Order ${id}</h1>
<p class="muted">Placed ${escapeHtml(order.placedAt.slice(0, 10))} · ${escapeHtml(SHIPPING[order.shipping].label)}${order.coupon ? ` · coupon ${escapeHtml(order.coupon)}` : ""}</p>
<table><tr><th>Item</th><th>Size</th><th>Qty</th><th>Price</th></tr>${order.lines
				.map(line => `<tr><td>${escapeHtml(line.name)} <span class="muted">${line.sku}</span></td><td>${escapeHtml(line.size)}</td><td>${line.quantity}</td><td>${money(line.unitCents)}</td></tr>`)
				.join("")}</table>
<table style="max-width:360px;margin-top:10px"><tr><td>Subtotal</td><td>${money(order.subtotalCents)}</td></tr><tr><td>Discount</td><td>${money(-order.discountCents)}</td></tr><tr><td>Shipping</td><td>${money(order.shippingCents)}</td></tr><tr><td>Tax</td><td>${money(order.taxCents)}</td></tr><tr><th>Total</th><th>${money(order.totalCents)}</th></tr></table>
<p>Ship to ${escapeHtml(`${order.address.name}, ${order.address.street}, ${order.address.city} ${order.address.postalCode}`)}</p>
${
	requested.length > 0
		? requested
				.map(
					entry =>
						`<p class="notice">Return ${escapeHtml(entry.reference)} requested: ${escapeHtml(
							entry.lines
								.map(line => {
									const name = order.lines.find(item => item.sku === line.sku && item.size === line.size)?.name ?? line.sku;
									return line.size === ONE_SIZE ? name : `${name} (${line.size})`;
								})
								.join(", "),
						)} · refund ${money(entry.refundCents)} to ${escapeHtml(entry.refund)}.</p>`,
				)
				.join("")
		: `<p><a href="/orders/${id}/return">Return items</a></p>`
}`,
		);
	};

	const returnPage = (session: string, id: string, error = "") => {
		const order = world.orders.find(entry => entry.id === id);
		if (!order) return text("No such order", { status: 404 });
		return render(
			session,
			`Return items from ${id}`,
			`<h1>Return items from order ${id}</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/orders/${id}/return">
<fieldset class="card"><legend>Items to return</legend>${order.lines
				.map(
					(line, index) =>
						`<label><input type="checkbox" name="line" value="${index}"> ${escapeHtml(line.name)} (${escapeHtml(line.size)}) × ${line.quantity}</label>`,
				)
				.join("")}</fieldset>
<label>Reason <select name="reason"><option value="">Choose a reason</option>${RETURN_REASONS.map(reason => `<option>${reason}</option>`).join("")}</select></label>
<fieldset class="card"><legend>Refund to</legend>${REFUND_METHODS.map(method => `<label><input type="radio" name="refund" value="${method}"> ${method}</label>`).join("")}</fieldset>
<button>Request return</button>
</form>`,
		);
	};

	const requestReturn = (session: string, id: string, fields: Record<string, string>): SiteResponse => {
		const order = world.orders.find(entry => entry.id === id);
		if (!order) return text("No such order", { status: 404 });
		const indexes = [
			...new Set(
				(fields.line ?? "")
					.split(",")
					.filter(Boolean)
					.map(Number)
					.filter(index => Number.isInteger(index) && order.lines[index]),
			),
		];
		if (indexes.length === 0) return returnPage(session, id, "Choose at least one item to return.");
		if (!RETURN_REASONS.some(reason => reason === fields.reason)) return returnPage(session, id, "Choose a reason.");
		if (!REFUND_METHODS.some(method => method === fields.refund)) return returnPage(session, id, "Choose where the refund goes.");
		let reference = `RMA-${rng.code(6)}`;
		while (returns.some(entry => entry.reference === reference)) reference = `RMA-${rng.code(6)}`;
		returns.push({
			reference,
			orderId: id,
			lines: indexes.map(index => {
				const line = order.lines[index] as Order["lines"][number];
				return { sku: line.sku, size: line.size, quantity: line.quantity };
			}),
			reason: fields.reason as string,
			refund: fields.refund as string,
			refundCents: refundCents(order, indexes),
		});
		return redirect(`/orders/${id}`);
	};

	const accountPage = (session: string) =>
		render(
			session,
			"Account",
			`<h1>${escapeHtml(world.account.name)}</h1>
<div class="grid"><a class="card" href="/orders">Order history</a><a class="card" href="/account/coupons">Coupons</a><a class="card" href="/account/messages">Messages (${world.messages.length})</a></div>`,
		);

	const couponsPage = (session: string) =>
		render(
			session,
			"Coupons",
			`<h1>Your coupons</h1><p class="muted">One coupon per order.</p>
<table><tr><th>Code</th><th>Offer</th></tr>${world.coupons.map(coupon => `<tr><td><code>${coupon.code}</code></td><td>${escapeHtml(describeCoupon(coupon))}</td></tr>`).join("")}</table>`,
		);

	const messagesPage = (session: string, id: string | null) => {
		if (id) {
			const message = world.messages.find(entry => entry.id === id);
			if (!message) return text("No such message", { status: 404 });
			return render(
				session,
				message.subject,
				`<p><a href="/account/messages">← Messages</a></p><div class="card"><h2>${escapeHtml(message.subject)}</h2><p class="muted">From ${escapeHtml(message.from)} · ${escapeHtml(message.date)}</p><p style="white-space:pre-wrap">${escapeHtml(message.body)}</p></div>`,
			);
		}
		return render(
			session,
			"Messages",
			`<h1>Messages</h1><table><tr><th>From</th><th>Subject</th><th>Date</th></tr>${world.messages
				.map(message => `<tr><td>${escapeHtml(message.from)}</td><td><a href="/account/messages/${message.id}">${escapeHtml(message.subject)}</a></td><td>${escapeHtml(message.date)}</td></tr>`)
				.join("")}</table>`,
		);
	};

	const ordersPage = (session: string) =>
		render(
			session,
			"Orders",
			`<h1>Order history</h1><table><tr><th>Order</th><th>Placed</th><th>Items</th><th>Total</th></tr>${world.orders
				.map(order => `<tr><td><a href="/orders/${order.id}">${order.id}</a></td><td>${escapeHtml(order.placedAt.slice(0, 10))}</td><td>${order.lines.reduce((sum, line) => sum + line.quantity, 0)}</td><td>${money(order.totalCents)}</td></tr>`)
				.join("")}</table>`,
		);

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

	const route = (request: SiteRequest, session: string): SiteResponse => {
		const { method, url } = request;
		const pathname = url.pathname;
		const fields = method === "POST" ? formFields(request) : {};
		if (pathname === "/" && method === "GET") return home(session);
		if (pathname === "/promo/dismiss" && method === "POST") {
			promoDismissed.add(session);
			return { status: 204 };
		}
		if (pathname === "/newsletter") {
			newsletterSignups++;
			return render(session, "Subscribed", "<h1>You're subscribed</h1><p>Watch your inbox for trail reports.</p>");
		}
		if (pathname === "/search") return search(session, url);
		const productMatch = /^\/product\/([A-Z0-9-]+)$/.exec(pathname);
		if (productMatch && method === "GET") return productPage(session, productMatch[1] as string);
		if (pathname === "/signin" && method === "GET") return signinPage(session, url.searchParams.get("next") ?? "/account");
		if (pathname === "/signin" && method === "POST") {
			if (fields.email?.trim().toLowerCase() === world.account.email && fields.password === world.account.password) {
				signedIn.add(session);
				return redirect(localPath(fields.next, "/account"));
			}
			failedSignins++;
			return signinPage(session, fields.next ?? "/account", "That email and password do not match an account.");
		}
		if (pathname === "/signout") {
			signedIn.delete(session);
			return redirect("/");
		}
		if (!signedIn.has(session)) return redirect(`/signin?next=${encodeURIComponent(`${pathname}${url.search}`)}`);

		if (pathname === "/cart/add" && method === "POST") {
			const item = findProduct(world, fields.sku ?? "");
			if (!item) return text("No such product", { status: 404 });
			const size = fields.size ?? "";
			const quantity = Number(fields.quantity ?? "1");
			if (!Object.hasOwn(item.stock, size)) return productPage(session, item.sku, "Choose a size.");
			if (!Number.isInteger(quantity) || quantity < 1) return productPage(session, item.sku, "Choose a quantity.");
			const inCart = world.cart.find(line => line.sku === item.sku && line.size === size);
			if ((item.stock[size] ?? 0) < quantity + (inCart?.quantity ?? 0)) {
				return productPage(session, item.sku, "Not enough stock in that size.");
			}
			if (inCart) inCart.quantity += quantity;
			else world.cart.push({ sku: item.sku, size, quantity });
			return redirect("/cart");
		}
		if (pathname === "/cart" && method === "GET") return cartPage(session);
		if (pathname === "/cart/update" && method === "POST") {
			const index = Number(fields.index);
			const quantity = Number(fields.quantity);
			const line = world.cart[index];
			if (!line || !Number.isInteger(quantity) || quantity < 0) return cartPage(session, "", "That quantity is not valid.");
			if (quantity === 0) world.cart.splice(index, 1);
			else {
				const item = findProduct(world, line.sku);
				if ((item?.stock[line.size] ?? 0) < quantity) return cartPage(session, "", "Not enough stock for that quantity.");
				line.quantity = quantity;
			}
			return redirect("/cart");
		}
		if (pathname === "/cart/coupon" && method === "POST") {
			const code = (fields.code ?? "").trim().toUpperCase();
			const coupon = world.coupons.find(entry => entry.code === code);
			if (!coupon) return cartPage(session, "", `${code || "That code"} is not one of your coupons.`);
			const subtotal = priceOrder(world, world.cart, null, "standard").subtotalCents;
			if (subtotal < coupon.minSubtotalCents) {
				return cartPage(session, "", `${coupon.code} needs a subtotal of ${money(coupon.minSubtotalCents)} or more.`);
			}
			world.appliedCoupon = coupon.code;
			return cartPage(session, `${coupon.code} applied.`);
		}
		if (pathname === "/cart/coupon/remove" && method === "POST") {
			world.appliedCoupon = null;
			return redirect("/cart");
		}
		if (pathname === "/checkout" && method === "GET") return checkoutPage(session);
		if (pathname === "/checkout" && method === "POST") return placeOrder(session, fields);
		if (pathname === "/orders") return ordersPage(session);
		const orderMatch = /^\/orders\/(W\d+)(\/return)?$/.exec(pathname);
		if (orderMatch) {
			const id = orderMatch[1] as string;
			if (orderMatch[2]) {
				return method === "POST" ? requestReturn(session, id, fields) : returnPage(session, id);
			}
			return orderPage(session, id, url.searchParams.get("placed") === "1");
		}
		if (pathname === "/account") return accountPage(session);
		if (pathname === "/account/coupons") return couponsPage(session);
		const messageMatch = /^\/account\/messages(?:\/([a-z0-9]+))?$/.exec(pathname);
		if (messageMatch) return messagesPage(session, messageMatch[1] ?? null);
		return text("Not found", { status: 404 });
	};

	const site = await hostSite(request => {
		const session = sessionOf(request);
		const response = route(request, session.id);
		return session.fresh
			? { ...response, cookies: [...(response.cookies ?? []), { name: SESSION_COOKIE, value: session.id }] }
			: response;
	});

	return {
		origin: site.origin,
		close: () => site.close(),
		async finish() {
			await site.close();
			return {
				orders: world.orders,
				returns,
				cart: world.cart,
				appliedCoupon: world.appliedCoupon,
				newsletterSignups,
				failedSignins,
				stock: Object.fromEntries(world.products.map(item => [item.sku, item.stock])),
			};
		},
	};
}

/** Describe the lines of an order in one sentence, for an instruction. */
export function describeLines(world: ShopWorld, lines: readonly CartLine[]): string {
	return lines
		.map(line => {
			const item = findProduct(world, line.sku);
			return `${line.quantity} × ${item?.name ?? line.sku}${line.size === ONE_SIZE ? "" : ` (${line.size})`}`;
		})
		.join(", ");
}
