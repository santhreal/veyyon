/**
 * Skyway's client-side behaviour: the airport type-ahead, the calendar date picker, the travellers
 * popover, the results list that loads behind a spinner, the seat map, and the listener that takes
 * PayBox's token from the payment frame. Each is plain JavaScript that reads its configuration from
 * a constant the page declares before it.
 */

/** JSON for a `<script>` block: `<` is escaped so no value can close the element. */
export function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export const SITE_STYLE = `
[hidden]{display:none!important}
header.app{background:#0c4a6e}
a.button{display:inline-block;text-decoration:none}
label.inline{display:inline-flex;gap:6px;align-items:center;margin:4px 12px 4px 0}
.search-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:10px 0}
.combo,.dp,.pax{position:relative}
.combo input[type=text],.dp .dp-text{width:100%}
[role=listbox]{position:absolute;z-index:20;top:100%;left:0;right:0;background:#fff;border:1px solid #cbd5e1;border-radius:4px;list-style:none;margin:2px 0 0;padding:4px 0;max-height:260px;overflow:auto}
[role=option]{padding:5px 10px;cursor:pointer}
[role=option][aria-selected=true],[role=option]:hover{background:#e0f2fe}
.dp-text{cursor:pointer;background:#fff}
.dp-pop{position:absolute;z-index:25;top:100%;left:0;background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:8px;width:260px;box-shadow:0 8px 20px rgba(15,23,42,.18)}
.dp-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.dp-head button{padding:2px 10px}
.dp-week,.dp-days{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}
.dp-week span{font-size:11px;color:#64748b}
.dp-days button{background:#fff;color:#0f172a;padding:5px 0;border-radius:4px}
.dp-days button:hover:not(:disabled){background:#e0f2fe}
.dp-days button[aria-pressed=true]{background:#0369a1;color:#fff}
.dp-days button:disabled{color:#cbd5e1;background:#fff}
.pax-pop{position:absolute;z-index:25;top:100%;left:0;background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:10px;width:260px;box-shadow:0 8px 20px rgba(15,23,42,.18)}
.pax-row{display:grid;grid-template-columns:1fr auto 28px auto;gap:6px;align-items:center;margin-bottom:6px}
.pax-row output{text-align:center}
.strip{display:flex;gap:6px;overflow-x:auto;margin:10px 0}
.strip .day{flex:1;min-width:110px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:6px;text-align:center;text-decoration:none;color:inherit}
.strip .day.current{border-color:#0369a1;background:#e0f2fe}
.strip .day.disabled{opacity:.45}
.strip .day strong{display:block}
.results-layout{display:grid;grid-template-columns:220px 1fr;gap:14px;align-items:start}
.filters fieldset{border:0;padding:0;margin:0 0 12px}
.filters legend{font-weight:600}
.filters input[type=range]{width:100%}
.sort{position:relative}
.sort [role=listbox]{width:220px;left:auto;right:0}
.spinner{padding:30px;text-align:center;color:#475569}
.spin{display:inline-block;width:14px;height:14px;border:2px solid #cbd5e1;border-top-color:#0369a1;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.flight-main{display:grid;grid-template-columns:1.2fr 1.4fr 1.3fr 1fr auto;gap:10px;align-items:center}
.times{font-size:17px}
button.link{background:none;color:#0369a1;padding:2px 0;text-decoration:underline}
.details ol{margin:6px 0;padding-left:20px}
.details .layover{list-style:none;color:#92400e;margin-left:-20px}
.fares{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:8px}
.fare{border:1px solid #cbd5e1;border-radius:6px;padding:8px}
.fare h4{margin:0}
.fare ul{margin:6px 0;padding-left:18px;font-size:13px}
.fare-price strong{font-size:17px}
.fare details{font-size:12px;margin:4px 0}
.chosen{background:#f0f9ff}
.price-table{max-width:560px}
.price-table .total th{font-size:16px}
#paybox-frame{width:100%;max-width:460px;height:450px;border:1px solid #cbd5e1;border-radius:6px;background:#fff}
.cookie{position:fixed;left:0;right:0;bottom:0;z-index:40;background:#111827;color:#f9fafb;padding:16px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.cookie p{margin:0;flex:1;min-width:240px}
.who{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.who label{border:1px solid #cbd5e1;border-radius:6px;padding:6px 10px;margin:0;cursor:pointer;background:#fff}
.who label:has(input:checked){border-color:#0369a1;background:#e0f2fe}
.legend{display:flex;gap:16px;list-style:none;padding:0;flex-wrap:wrap}
.legend li{display:flex;gap:6px;align-items:center}
.cabin{display:inline-block;background:#fff;border:1px solid #e5e7eb;border-radius:30px 30px 8px 8px;padding:16px 14px}
.cabin-row{display:grid;grid-template-columns:70px repeat(3,30px) 22px repeat(3,30px);gap:4px;align-items:center;margin-bottom:4px}
.cabin-row .col{text-align:center;font-weight:600;font-size:12px;line-height:1.1}
.cabin-row .col small{display:block;font-weight:400;color:#64748b;font-size:9px}
.rownum{font-size:12px;color:#475569}
.rownum small{display:block;font-size:9px;color:#b45309}
.seat{width:30px;height:28px;padding:0;border-radius:6px 6px 3px 3px;border:1px solid #94a3b8;background:#dbeafe;color:#1e3a8a;font-size:9px}
.seat.xl{background:#fde68a;border-color:#d97706;color:#78350f}
.seat.taken,.seat:disabled{background:#e5e7eb;border-color:#e5e7eb;opacity:1;cursor:not-allowed}
.seat.mine{background:#16a34a;border-color:#15803d;color:#fff}
span.seat{display:inline-block}
.danger{color:#b91c1c}
`;

export const COOKIE_SCRIPT = `
(() => {
	const banner = document.getElementById("cookie-banner");
	if (!banner) return;
	for (const button of banner.querySelectorAll("button")) {
		button.addEventListener("click", async () => {
			await fetch("/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice: button.dataset.choice }) });
			banner.remove();
		});
	}
})();
`;

/** Type-ahead airport fields: `[data-combobox]` holding a text combobox, a hidden code and a listbox. */
export const COMBOBOX_SCRIPT = `
for (const root of document.querySelectorAll("[data-combobox]")) {
	const input = root.querySelector("input[role=combobox]");
	const hidden = root.querySelector("input[type=hidden]");
	const list = root.querySelector("[role=listbox]");
	let options = [];
	let active = -1;
	let timer = 0;
	const close = () => {
		list.hidden = true;
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
		active = -1;
	};
	const choose = option => {
		hidden.value = option.dataset.code;
		input.value = option.dataset.label;
		close();
	};
	const highlight = index => {
		active = index;
		options.forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
		if (options[index]) input.setAttribute("aria-activedescendant", options[index].id);
	};
	input.addEventListener("input", () => {
		hidden.value = "";
		clearTimeout(timer);
		const query = input.value.trim();
		if (query.length < 2) {
			close();
			return;
		}
		timer = setTimeout(async () => {
			const response = await fetch("/api/airports?q=" + encodeURIComponent(query));
			const airports = await response.json();
			if (input.value.trim() !== query) return;
			list.innerHTML = "";
			options = airports.map((airport, i) => {
				const option = document.createElement("li");
				option.id = root.dataset.combobox + "-option-" + i;
				option.setAttribute("role", "option");
				option.setAttribute("aria-selected", "false");
				option.dataset.code = airport.code;
				option.dataset.label = airport.city + " (" + airport.code + ")";
				const city = document.createElement("strong");
				city.textContent = option.dataset.label;
				const name = document.createElement("div");
				name.className = "muted";
				name.textContent = airport.name;
				option.append(city, name);
				option.addEventListener("click", () => choose(option));
				list.appendChild(option);
				return option;
			});
			if (options.length === 0) list.innerHTML = '<li class="muted" style="padding:5px 10px">No airport matches</li>';
			list.hidden = false;
			input.setAttribute("aria-expanded", "true");
		}, 300);
	});
	input.addEventListener("keydown", event => {
		if (list.hidden) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			highlight(Math.min(options.length - 1, active + 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			highlight(Math.max(0, active - 1));
		} else if (event.key === "Enter" && options[active]) {
			event.preventDefault();
			choose(options[active]);
		} else if (event.key === "Escape") {
			close();
		}
	});
	input.addEventListener("blur", () => setTimeout(close, 250));
}
`;

/**
 * Calendar date pickers: `[data-datepicker]` with `data-min`/`data-max`, a read-only text field, a
 * hidden ISO value and a popover. A picker fires `datechange` on its root and exposes
 * `root.picker.setMin(date)`.
 */
export const DATE_PICKER_SCRIPT = `
(() => {
	const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	const pad = n => String(n).padStart(2, "0");
	const iso = (y, m, d) => y + "-" + pad(m + 1) + "-" + pad(d);
	const parts = value => { const [y, m, d] = value.split("-").map(Number); return { y, m: m - 1, d }; };
	const label = value => {
		const p = parts(value);
		const day = new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay();
		return DAYS[day].slice(0, 3) + " " + p.d + " " + MONTHS[p.m].slice(0, 3) + " " + p.y;
	};
	for (const root of document.querySelectorAll("[data-datepicker]")) {
		const text = root.querySelector(".dp-text");
		const hidden = root.querySelector("input[type=hidden]");
		const pop = root.querySelector(".dp-pop");
		const title = root.querySelector(".dp-title");
		const grid = root.querySelector(".dp-days");
		const prev = root.querySelector(".dp-prev");
		const next = root.querySelector(".dp-next");
		const bounds = { min: root.dataset.min || "", max: root.dataset.max || "" };
		let view = parts(hidden.value || bounds.min);
		const render = () => {
			title.textContent = MONTHS[view.m] + " " + view.y;
			grid.innerHTML = "";
			const first = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
			const count = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
			for (let i = 0; i < first; i++) grid.appendChild(document.createElement("span"));
			for (let d = 1; d <= count; d++) {
				const value = iso(view.y, view.m, d);
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = String(d);
				button.dataset.date = value;
				button.setAttribute("aria-label", label(value));
				button.setAttribute("aria-pressed", String(value === hidden.value));
				button.disabled = (bounds.min && value < bounds.min) || (bounds.max && value > bounds.max);
				button.addEventListener("click", () => {
					set(value);
					close();
				});
				grid.appendChild(button);
			}
			prev.disabled = Boolean(bounds.min) && iso(view.y, view.m, 1) <= bounds.min;
			next.disabled = Boolean(bounds.max) && iso(view.y, view.m, count) >= bounds.max;
		};
		const set = value => {
			hidden.value = value;
			text.value = value ? label(value) : "";
			root.dispatchEvent(new CustomEvent("datechange", { detail: value }));
		};
		const open = () => {
			view = parts(hidden.value || bounds.min);
			render();
			pop.hidden = false;
			text.setAttribute("aria-expanded", "true");
		};
		const close = () => {
			pop.hidden = true;
			text.setAttribute("aria-expanded", "false");
		};
		text.addEventListener("click", () => (pop.hidden ? open() : close()));
		text.addEventListener("keydown", event => {
			if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
				event.preventDefault();
				open();
			} else if (event.key === "Escape") {
				close();
			}
		});
		prev.addEventListener("click", () => {
			view = view.m === 0 ? { y: view.y - 1, m: 11 } : { y: view.y, m: view.m - 1 };
			render();
		});
		next.addEventListener("click", () => {
			view = view.m === 11 ? { y: view.y + 1, m: 0 } : { y: view.y, m: view.m + 1 };
			render();
		});
		document.addEventListener("mousedown", event => {
			if (!pop.hidden && !root.contains(event.target)) close();
		});
		root.picker = {
			setMin: value => {
				bounds.min = value;
				if (hidden.value && hidden.value < value) set("");
			},
		};
		if (hidden.value) text.value = label(hidden.value);
	}
})();
`;

/** The search form: trip type, the depart date bounding the return date, the travellers popover. */
export const SEARCH_FORM_SCRIPT = `
(() => {
	const form = document.getElementById("search-form");
	const returnField = document.getElementById("return-field");
	const depart = form.querySelector('[data-datepicker="depart"]');
	const back = form.querySelector('[data-datepicker="return"]');
	const error = document.getElementById("search-error");
	const oneWay = () => form.querySelector("input[name=trip]:checked").value === "oneway";
	for (const radio of form.querySelectorAll("input[name=trip]")) {
		radio.addEventListener("change", () => { returnField.hidden = oneWay(); });
	}
	returnField.hidden = oneWay();
	depart.addEventListener("datechange", event => back.picker.setMin(event.detail || depart.dataset.min));
	const pax = form.querySelector("[data-pax]");
	const toggle = pax.querySelector(".pax-toggle");
	const pop = pax.querySelector(".pax-pop");
	const counts = { adults: Number(form.querySelector("input[name=adults]").value), children: Number(form.querySelector("input[name=children]").value) };
	const limits = { adults: [1, 6], children: [0, 5] };
	const describe = () => counts.adults + (counts.adults === 1 ? " adult" : " adults") + (counts.children ? ", " + counts.children + (counts.children === 1 ? " child" : " children") : "");
	const paint = () => {
		for (const kind of ["adults", "children"]) {
			pax.querySelector('[data-count="' + kind + '"]').textContent = String(counts[kind]);
			form.querySelector("input[name=" + kind + "]").value = String(counts[kind]);
		}
		for (const button of pax.querySelectorAll("[data-kind]")) {
			const kind = button.dataset.kind;
			const by = Number(button.dataset.by);
			const [low, high] = limits[kind];
			button.disabled = by < 0 ? counts[kind] <= low : counts[kind] >= high || counts.adults + counts.children >= 7;
		}
		toggle.textContent = describe();
	};
	for (const button of pax.querySelectorAll("[data-kind]")) {
		button.addEventListener("click", () => {
			const kind = button.dataset.kind;
			const [low, high] = limits[kind];
			counts[kind] = Math.max(low, Math.min(high, counts[kind] + Number(button.dataset.by)));
			paint();
		});
	}
	toggle.addEventListener("click", () => {
		pop.hidden = !pop.hidden;
		toggle.setAttribute("aria-expanded", String(!pop.hidden));
	});
	pax.querySelector(".pax-done").addEventListener("click", () => {
		pop.hidden = true;
		toggle.setAttribute("aria-expanded", "false");
	});
	paint();
	form.addEventListener("submit", event => {
		const missing = [];
		if (!form.querySelector("input[name=from]").value) missing.push("choose where you fly from in the list of airports");
		if (!form.querySelector("input[name=to]").value) missing.push("choose where you fly to in the list of airports");
		if (!form.querySelector("input[name=depart]").value) missing.push("choose a departure date");
		if (!oneWay() && !form.querySelector("input[name=return]").value) missing.push("choose a return date");
		if (missing.length > 0) {
			event.preventDefault();
			error.textContent = "To search, " + missing.join(", ") + ".";
		}
	});
})();
`;

/** The results list. The page declares `RESULTS` with the route, date and leg. */
export const RESULTS_SCRIPT = `
(() => {
	const results = document.getElementById("results");
	const spinner = document.getElementById("spinner");
	const more = document.getElementById("more");
	const count = document.getElementById("result-count");
	const filters = document.getElementById("filters");
	const choose = document.getElementById("choose");
	const depMin = document.getElementById("dep-min");
	const depMax = document.getElementById("dep-max");
	const sortButton = document.getElementById("sort-button");
	const sortList = document.getElementById("sort-options");
	const PAGE = 6;
	let sort = "recommended";
	let offset = 0;
	let generation = 0;
	const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const money = cents => "$" + (cents / 100).toFixed(2);
	const hour = value => String(value).padStart(2, "0") + ":00";
	const stopsText = item => item.stops === 0 ? "Nonstop" : item.stops + (item.stops === 1 ? " stop" : " stops") + " (" + item.layovers.map(l => l.airport).join(", ") + ")";
	const details = item => item.segments.map((s, i) => {
		const layover = item.layovers[i];
		return '<li>' + esc(s.flightNo) + ' · ' + esc(s.fromCity) + ' (' + s.from + ') ' + s.depart + ' → ' + esc(s.toCity) + ' (' + s.to + ') ' + s.arrive + (s.nextDay ? ' (next day)' : '') + ' · ' + s.duration + '</li>'
			+ (layover ? '<li class="layover">Change planes in ' + esc(layover.city) + ': ' + layover.text + ' between flights</li>' : '');
	}).join("");
	const fareCard = fare => '<div class="fare">'
		+ '<h4>' + esc(fare.name) + '</h4><div class="muted">' + fare.cabin + '</div>'
		+ '<ul><li>Personal item</li><li>' + (fare.carryOn ? 'Carry-on bag included' : 'No carry-on bag') + '</li>'
		+ '<li>' + (fare.checkedBags ? fare.checkedBags + ' checked bag' + (fare.checkedBags > 1 ? 's' : '') + ' included' : 'No checked bag') + '</li>'
		+ '<li>' + esc(fare.changes) + '</li><li>' + (fare.refundable ? 'Refundable' : 'Non-refundable') + '</li></ul>'
		+ '<div class="fare-price"><strong>' + money(fare.adultCents) + '</strong> per adult</div>'
		+ '<details><summary>Fare details</summary><p>Child (2–11): ' + money(fare.childCents) + ' per child</p><p>' + esc(fare.seats) + '</p></details>'
		+ '<button type="button" class="choose-fare" data-fare="' + esc(fare.id) + '">Choose ' + esc(fare.name) + '</button></div>';
	const card = item => {
		const article = document.createElement("article");
		article.className = "card flight";
		article.dataset.id = item.id;
		article.innerHTML = '<div class="flight-main">'
			+ '<div class="times"><strong>' + item.depart + '</strong> – <strong>' + item.arrive + '</strong>' + (item.nextDay ? ' <sup title="Arrives the next day">+1</sup>' : '') + '</div>'
			+ '<div>' + esc(item.airlineName) + '<div class="muted">' + item.segments.map(s => esc(s.flightNo)).join(" · ") + '</div></div>'
			+ '<div>' + item.durationText + '<div class="muted">' + esc(stopsText(item)) + '</div></div>'
			+ '<div class="price">from <strong>' + money(item.fromCents) + '</strong><div class="muted">per adult</div></div>'
			+ '<button type="button" class="select-flight" aria-expanded="false">Select</button></div>'
			+ '<button type="button" class="link toggle-details" aria-expanded="false">Flight details</button>'
			+ '<div class="details" hidden><ol>' + details(item) + '</ol></div>'
			+ '<div class="fares" hidden>' + item.fares.map(fareCard).join("") + '</div>';
		const toggle = (button, panel) => button.addEventListener("click", () => {
			panel.hidden = !panel.hidden;
			button.setAttribute("aria-expanded", String(!panel.hidden));
		});
		toggle(article.querySelector(".select-flight"), article.querySelector(".fares"));
		toggle(article.querySelector(".toggle-details"), article.querySelector(".details"));
		for (const button of article.querySelectorAll(".choose-fare")) {
			button.addEventListener("click", () => {
				choose.querySelector("input[name=itinerary]").value = item.id;
				choose.querySelector("input[name=fare]").value = button.dataset.fare;
				choose.submit();
			});
		}
		return article;
	};
	const query = () => {
		const params = new URLSearchParams({ from: RESULTS.from, to: RESULTS.to, date: RESULTS.date, sort, offset: String(offset), limit: String(PAGE) });
		params.set("stops", [...filters.querySelectorAll("input[name=stops]:checked")].map(i => i.value).join(","));
		params.set("airlines", [...filters.querySelectorAll("input[name=airlines]:checked")].map(i => i.value).join(","));
		params.set("depMin", depMin.value);
		params.set("depMax", depMax.value);
		return params;
	};
	const load = async reset => {
		const mine = ++generation;
		if (reset) {
			offset = 0;
			results.innerHTML = "";
			count.textContent = "";
		}
		spinner.hidden = false;
		more.hidden = true;
		const started = Date.now();
		const response = await fetch("/api/search?" + query());
		const data = await response.json();
		setTimeout(() => {
			if (mine !== generation) return;
			spinner.hidden = true;
			count.textContent = data.total + (data.total === 1 ? " flight" : " flights");
			if (data.total === 0) results.innerHTML = '<p class="card">No flights match your filters.</p>';
			for (const item of data.items) results.appendChild(card(item));
			offset += data.items.length;
			more.hidden = offset >= data.total;
		}, Math.max(0, 1200 - (Date.now() - started)));
	};
	for (const input of filters.querySelectorAll("input[type=checkbox]")) input.addEventListener("change", () => load(true));
	for (const range of [depMin, depMax]) {
		range.addEventListener("input", () => {
			if (Number(depMin.value) > Number(depMax.value)) (range === depMin ? depMax : depMin).value = range.value;
			document.getElementById("dep-min-out").textContent = hour(depMin.value);
			document.getElementById("dep-max-out").textContent = hour(depMax.value);
		});
		range.addEventListener("change", () => load(true));
	}
	more.addEventListener("click", () => load(false));
	sortButton.addEventListener("click", () => {
		sortList.hidden = !sortList.hidden;
		sortButton.setAttribute("aria-expanded", String(!sortList.hidden));
	});
	for (const option of sortList.querySelectorAll("[role=option]")) {
		option.addEventListener("click", () => {
			sort = option.dataset.value;
			for (const other of sortList.querySelectorAll("[role=option]")) other.setAttribute("aria-selected", String(other === option));
			sortButton.textContent = "Sort: " + option.textContent;
			sortList.hidden = true;
			sortButton.setAttribute("aria-expanded", "false");
			load(true);
		});
	}
	load(true);
})();
`;

/** The checkout: the insurance box repriced on the server, and the fare rules gating the payment frame. */
export const CHECKOUT_SCRIPT = `
(() => {
	const insurance = document.getElementById("insurance");
	const accept = document.getElementById("accept-rules");
	const payment = document.getElementById("payment");
	const frame = document.getElementById("paybox-frame");
	insurance.addEventListener("change", async () => {
		insurance.disabled = true;
		await fetch("/api/checkout/insurance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: insurance.checked }) });
		location.reload();
	});
	accept.addEventListener("change", () => {
		payment.hidden = !accept.checked;
		if (accept.checked && !frame.getAttribute("src")) frame.setAttribute("src", frame.dataset.src);
	});
})();
`;

/**
 * Take PayBox's token from the frame and complete the purchase on the server. The page declares
 * `PAYMENT` with PayBox's origin, the URL to post to and the body to post with the token.
 */
export const PAYMENT_SCRIPT = `
window.addEventListener("message", async event => {
	if (event.origin !== PAYMENT.origin || !event.data || event.data.type !== "paybox:token") return;
	const status = document.getElementById("payment-status");
	status.className = "";
	status.textContent = "Payment authorized. Confirming…";
	const response = await fetch(PAYMENT.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({}, PAYMENT.body, { token: event.data.token })) });
	const result = await response.json().catch(() => ({}));
	if (response.ok && result.redirect) {
		location.href = result.redirect;
		return;
	}
	status.className = "error";
	status.textContent = result.error || "The payment could not be completed.";
	const frame = document.getElementById("paybox-frame");
	frame.setAttribute("src", frame.getAttribute("src"));
});
`;

/** A button that confirms a change costing nothing. The page declares `PAYMENT` as for a payment. */
export const CONFIRM_FREE_SCRIPT = `
document.getElementById("confirm-free").addEventListener("click", async event => {
	event.target.disabled = true;
	const response = await fetch(PAYMENT.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(PAYMENT.body) });
	const result = await response.json().catch(() => ({}));
	if (response.ok && result.redirect) location.href = result.redirect;
	else document.getElementById("payment-status").textContent = result.error || "The change could not be made.";
});
`;

/** The seat map. The page declares `SEATS` with the travellers' current seats and each seat's fee. */
export const SEATS_SCRIPT = `
(() => {
	const state = SEATS.current.slice();
	let who = 0;
	const fee = document.getElementById("seat-fee");
	const save = document.getElementById("save-seats");
	const status = document.getElementById("payment-status");
	const payment = document.getElementById("payment");
	const frame = document.getElementById("paybox-frame");
	const money = cents => "$" + (cents / 100).toFixed(2);
	const paint = () => {
		for (const seat of document.querySelectorAll(".cabin button.seat")) {
			const mine = state.includes(seat.dataset.seat);
			seat.classList.toggle("mine", mine);
			seat.setAttribute("aria-pressed", String(mine));
		}
		state.forEach((seat, i) => { document.querySelector('[data-seat-of="' + i + '"]').textContent = seat || "no seat"; });
		const total = state.reduce((sum, seat, i) => sum + (seat && seat !== SEATS.current[i] ? SEATS.fees[seat] || 0 : 0), 0);
		fee.textContent = money(total);
	};
	for (const radio of document.querySelectorAll("input[name=who]")) {
		radio.addEventListener("change", () => { who = Number(document.querySelector("input[name=who]:checked").value); });
	}
	for (const seat of document.querySelectorAll(".cabin button.seat")) {
		seat.addEventListener("click", () => {
			const holder = state.indexOf(seat.dataset.seat);
			if (holder !== -1 && holder !== who) {
				status.className = "error";
				status.textContent = "Seat " + seat.dataset.seat + " is already chosen for another traveller.";
				return;
			}
			status.className = "";
			status.textContent = "";
			state[who] = seat.dataset.seat;
			paint();
		});
	}
	save.addEventListener("click", async () => {
		save.disabled = true;
		PAYMENT.body = { leg: SEATS.leg, segment: SEATS.segment, seats: state };
		const response = await fetch(PAYMENT.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(PAYMENT.body) });
		const result = await response.json().catch(() => ({}));
		save.disabled = false;
		if (response.ok && result.redirect) {
			location.href = result.redirect;
			return;
		}
		if (result.needsPayment) {
			status.className = "";
			status.textContent = "These seats cost " + money(result.amountCents) + ". Pay below to keep them.";
			frame.setAttribute("src", result.frame);
			payment.hidden = false;
			return;
		}
		status.className = "error";
		status.textContent = result.error || "The seats could not be saved.";
	});
	paint();
})();
`;

/** The travellers form: fill the first adult from the account's profile. The page declares `PROFILE`. */
export const TRAVELLERS_SCRIPT = `
document.getElementById("fill-profile").addEventListener("click", () => {
	for (const [field, value] of Object.entries(PROFILE)) document.querySelector("input[name=t0_" + field + "]").value = value;
});
`;
