/**
 * The browser code of Metricly's pages, served inline. The dashboard reads its starting state from
 * `window.__METRICLY__`, draws each chart on a canvas once the widget scrolls into view, and shows a
 * chart's exact values only in the tooltip that follows the pointer.
 */

export const DASHBOARD_SCRIPT = String.raw`
(function () {
	"use strict";
	var B = window.__METRICLY__;
	var DIMS = ["countries", "plans", "channels"];
	var PARAM = { countries: "country", plans: "plan", channels: "channel" };
	var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	var PAD = { l: 72, r: 16, t: 14, b: 40 };
	var HEIGHT = 280;
	var LOAD_DELAY_MS = 700;
	var state = {
		from: B.view.from,
		to: B.view.to,
		group: B.view.group,
		countries: B.view.countries.slice(),
		plans: B.view.plans.slice(),
		channels: B.view.channels.slice()
	};

	function dayNum(iso) { var p = iso.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; }
	function isoOf(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
	function addDays(iso, n) { return isoOf(dayNum(iso) + n); }
	function shortDate(iso) { var p = iso.split("-"); return MONTHS[+p[1] - 1].slice(0, 3) + " " + (+p[2]) + ", " + p[0]; }
	function exact(n, money) { var s = Math.round(n).toLocaleString("en-US"); return money ? "$" + s : s; }
	function compact(n, money) {
		var a = Math.abs(n), s;
		if (a >= 1e6) s = (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
		else if (a >= 1e3) s = (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
		else s = String(Math.round(n));
		return money ? "$" + s : s;
	}
	function labelOf(dim, id) {
		var hit = B.dims[dim].filter(function (v) { return v.id === id; })[0];
		return hit ? hit.label : id;
	}
	function params(extra) {
		var q = new URLSearchParams();
		q.set("from", state.from);
		q.set("to", state.to);
		q.set("group", state.group);
		DIMS.forEach(function (d) { if (state[d].length) q.set(PARAM[d], state[d].join(",")); });
		Object.keys(extra || {}).forEach(function (k) { if (extra[k]) q.set(k, extra[k]); });
		return q.toString();
	}
	function el(tag, attrs, text) {
		var node = document.createElement(tag);
		Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
		if (text !== undefined) node.textContent = text;
		return node;
	}

	// ---- controls
	var rangeButton = document.getElementById("range-button");
	var rangeLabel = document.getElementById("range-label");
	var picker = document.getElementById("range-picker");

	function renderControls() {
		rangeLabel.textContent = shortDate(state.from) + " – " + shortDate(state.to);
		document.querySelectorAll("[data-group]").forEach(function (b) {
			b.setAttribute("aria-checked", String(b.dataset.group === state.group));
		});
		document.querySelectorAll(".toolbar .chips").forEach(function (box) {
			var list = state[box.dataset.dim];
			box.querySelectorAll(".chip").forEach(function (chip) {
				chip.setAttribute("aria-pressed", String(list.indexOf(chip.dataset.value) >= 0));
			});
		});
	}

	function changed() {
		history.replaceState(null, "", "/?" + params());
		renderControls();
		var notice = document.getElementById("default-notice");
		if (notice) notice.hidden = true;
		widgets.forEach(reset);
	}

	document.querySelectorAll("[data-group]").forEach(function (b) {
		b.addEventListener("click", function () {
			if (state.group === b.dataset.group) return;
			state.group = b.dataset.group;
			changed();
		});
	});
	document.querySelectorAll(".toolbar .chips").forEach(function (box) {
		box.addEventListener("click", function (e) {
			var chip = e.target.closest(".chip");
			if (!chip) return;
			var dim = box.dataset.dim, list = state[dim], at = list.indexOf(chip.dataset.value);
			if (at >= 0) list.splice(at, 1);
			else list.push(chip.dataset.value);
			var order = B.dims[dim].map(function (v) { return v.id; });
			list.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
			changed();
		});
	});
	document.getElementById("clear-filters").addEventListener("click", function () {
		DIMS.forEach(function (d) { state[d] = []; });
		changed();
	});

	// ---- date-range picker
	var draft = null;
	var viewMonth = 0;
	function monthIndex(iso) { var p = iso.split("-"); return +p[0] * 12 + (+p[1] - 1); }
	var firstMonth = monthIndex(B.start);
	var lastMonth = monthIndex(B.today);
	function rightMonthFor(iso) { return Math.max(firstMonth + 1, monthIndex(iso)); }

	function openPicker() {
		draft = { from: state.from, to: state.to };
		viewMonth = rightMonthFor(state.to);
		picker.hidden = false;
		rangeButton.setAttribute("aria-expanded", "true");
		renderPicker();
	}
	function closePicker() {
		picker.hidden = true;
		rangeButton.setAttribute("aria-expanded", "false");
	}
	function monthGrid(index) {
		var year = Math.floor(index / 12), month = index % 12;
		var box = el("div", { "class": "month" });
		box.appendChild(el("div", { "class": "month-title" }, MONTHS[month] + " " + year));
		var grid = el("div", { "class": "days" });
		["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(function (d) { grid.appendChild(el("span", { "class": "dow" }, d)); });
		var first = isoOf(Date.UTC(year, month, 1) / 86400000);
		var lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
		for (var k = 0; k < lead; k++) grid.appendChild(el("span"));
		var count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
		var end = draft.to === null ? draft.from : draft.to;
		for (var n = 1; n <= count; n++) {
			var iso = addDays(first, n - 1);
			var cls = "day";
			if (iso === draft.from || iso === draft.to) cls += " edge";
			else if (iso > draft.from && iso < end) cls += " in-range";
			var b = el("button", { type: "button", "class": cls, "data-date": iso, "aria-label": n + " " + MONTHS[month] + " " + year }, String(n));
			b.disabled = iso < B.start || iso > B.today;
			grid.appendChild(b);
		}
		box.appendChild(grid);
		return box;
	}
	function renderPicker() {
		picker.textContent = "";
		var presets = el("div", { "class": "presets", role: "group", "aria-label": "Presets" });
		B.presets.forEach(function (p) {
			var on = draft.to !== null && draft.from === p.from && draft.to === p.to;
			presets.appendChild(el("button", { type: "button", "data-preset": p.id, "aria-pressed": String(on) }, p.label));
		});
		picker.appendChild(presets);
		var cal = el("div", { "class": "calendar" });
		var nav = el("div", { "class": "cal-nav" });
		var prev = el("button", { type: "button", id: "cal-prev", "class": "secondary", "aria-label": "Previous month" }, "‹");
		prev.disabled = viewMonth - 1 <= firstMonth;
		var next = el("button", { type: "button", id: "cal-next", "class": "secondary", "aria-label": "Next month" }, "›");
		next.disabled = viewMonth >= lastMonth;
		nav.appendChild(prev);
		nav.appendChild(next);
		cal.appendChild(nav);
		var months = el("div", { "class": "months" });
		months.appendChild(monthGrid(viewMonth - 1));
		months.appendChild(monthGrid(viewMonth));
		cal.appendChild(months);
		var foot = el("div", { "class": "picker-foot" });
		foot.appendChild(el("span", { id: "draft-label" }, draft.to === null
			? shortDate(draft.from) + " – choose an end date"
			: shortDate(draft.from) + " – " + shortDate(draft.to)));
		var back = el("button", { type: "button", id: "shift-back", "class": "secondary", title: "Move the range one week earlier" }, "‹ 1 week");
		back.disabled = draft.to === null || addDays(draft.from, -7) < B.start;
		var forward = el("button", { type: "button", id: "shift-forward", "class": "secondary", title: "Move the range one week later" }, "1 week ›");
		forward.disabled = draft.to === null || addDays(draft.to, 7) > B.today;
		var cancel = el("button", { type: "button", id: "range-cancel", "class": "secondary" }, "Cancel");
		var apply = el("button", { type: "button", id: "range-apply" }, "Apply");
		apply.disabled = draft.to === null;
		[back, forward, cancel, apply].forEach(function (b) { foot.appendChild(b); });
		cal.appendChild(foot);
		picker.appendChild(cal);
	}
	rangeButton.addEventListener("click", function (e) {
		e.stopPropagation();
		if (picker.hidden) openPicker();
		else closePicker();
	});
	document.addEventListener("click", function () { if (!picker.hidden) closePicker(); });
	picker.addEventListener("click", function (e) {
		e.stopPropagation();
		var t = e.target.closest("button");
		if (!t || t.disabled) return;
		if (t.dataset.preset) {
			var preset = B.presets.filter(function (p) { return p.id === t.dataset.preset; })[0];
			draft = { from: preset.from, to: preset.to };
			viewMonth = rightMonthFor(preset.to);
		} else if (t.dataset.date) {
			var d = t.dataset.date;
			if (draft.to !== null) draft = { from: d, to: null };
			else if (d < draft.from) draft = { from: d, to: draft.from };
			else draft.to = d;
		} else if (t.id === "cal-prev") {
			viewMonth = Math.max(firstMonth + 1, viewMonth - 1);
		} else if (t.id === "cal-next") {
			viewMonth = Math.min(lastMonth, viewMonth + 1);
		} else if (t.id === "shift-back" || t.id === "shift-forward") {
			var step = t.id === "shift-back" ? -7 : 7;
			draft = { from: addDays(draft.from, step), to: addDays(draft.to, step) };
			viewMonth = rightMonthFor(draft.to);
		} else if (t.id === "range-apply") {
			state.from = draft.from;
			state.to = draft.to;
			closePicker();
			changed();
			return;
		} else if (t.id === "range-cancel") {
			closePicker();
			return;
		}
		renderPicker();
	});

	// ---- widgets
	var widgets = [];
	function geometry(w) {
		var width = w.canvas.clientWidth;
		var n = w.points ? w.points.length : 0;
		var plot = width - PAD.l - PAD.r;
		return { width: width, plot: plot, band: n ? plot / n : plot, n: n };
	}
	function niceMax(v) {
		if (v <= 0) return 1;
		var e = Math.pow(10, Math.floor(Math.log10(v)));
		var m = v / e;
		return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e;
	}
	function draw(w) {
		var c = w.canvas, ratio = window.devicePixelRatio || 1, geo = geometry(w);
		c.width = Math.round(geo.width * ratio);
		c.height = Math.round(HEIGHT * ratio);
		var g = c.getContext("2d");
		g.setTransform(ratio, 0, 0, ratio, 0, 0);
		g.clearRect(0, 0, geo.width, HEIGHT);
		if (!geo.n) return;
		var ph = HEIGHT - PAD.t - PAD.b;
		var top = niceMax(Math.max.apply(null, w.points.map(function (p) { return p.value; })));
		function y(v) { return PAD.t + ph - (v / top) * ph; }
		g.font = "11px system-ui, sans-serif";
		g.lineWidth = 1;
		g.textAlign = "right";
		g.textBaseline = "middle";
		for (var i = 0; i <= 4; i++) {
			var v = (top * i) / 4, yy = Math.round(y(v)) + 0.5;
			g.strokeStyle = "#eef0f3";
			g.beginPath(); g.moveTo(PAD.l, yy); g.lineTo(PAD.l + geo.plot, yy); g.stroke();
			g.fillStyle = "#6b7280";
			g.fillText(compact(v, w.money), PAD.l - 8, yy);
		}
		if (w.hover >= 0) {
			g.fillStyle = "rgba(37,99,235,0.08)";
			g.fillRect(PAD.l + geo.band * w.hover, PAD.t, geo.band, ph);
		}
		g.strokeStyle = "#9ca3af";
		g.beginPath(); g.moveTo(PAD.l + 0.5, PAD.t); g.lineTo(PAD.l + 0.5, PAD.t + ph + 0.5); g.lineTo(PAD.l + geo.plot, PAD.t + ph + 0.5); g.stroke();
		var every = Math.max(1, Math.ceil(64 / geo.band));
		g.fillStyle = "#6b7280";
		g.textAlign = "center";
		g.textBaseline = "top";
		w.points.forEach(function (p, i) { if (i % every === 0) g.fillText(p.tick, PAD.l + geo.band * (i + 0.5), PAD.t + ph + 8); });
		if (w.chart === "bar") {
			var bw = Math.max(1, Math.min(48, geo.band * 0.7));
			w.points.forEach(function (p, i) {
				g.fillStyle = i === w.hover ? "#1d4ed8" : "#60a5fa";
				g.fillRect(PAD.l + geo.band * (i + 0.5) - bw / 2, y(p.value), bw, PAD.t + ph - y(p.value));
			});
		} else {
			g.strokeStyle = "#2563eb";
			g.lineWidth = 2;
			g.beginPath();
			w.points.forEach(function (p, i) {
				var x = PAD.l + geo.band * (i + 0.5);
				if (i === 0) g.moveTo(x, y(p.value));
				else g.lineTo(x, y(p.value));
			});
			g.stroke();
			w.points.forEach(function (p, i) {
				g.fillStyle = i === w.hover ? "#1d4ed8" : "#2563eb";
				g.beginPath();
				g.arc(PAD.l + geo.band * (i + 0.5), y(p.value), i === w.hover ? 4.5 : 2.5, 0, Math.PI * 2);
				g.fill();
			});
		}
	}
	function indexAt(w, e) {
		if (!w.points || !w.points.length) return -1;
		var rect = w.canvas.getBoundingClientRect(), geo = geometry(w);
		var x = e.clientX - rect.left, yy = e.clientY - rect.top;
		if (x < PAD.l || x >= PAD.l + geo.plot || yy < PAD.t || yy > HEIGHT) return -1;
		return Math.min(geo.n - 1, Math.floor((x - PAD.l) / geo.band));
	}
	function hover(w, e) {
		var i = indexAt(w, e);
		if (i < 0) { unhover(w); return; }
		if (i !== w.hover) { w.hover = i; draw(w); }
		var p = w.points[i], geo = geometry(w);
		w.tip.textContent = "";
		w.tip.appendChild(el("strong", {}, p.label));
		w.tip.appendChild(el("div", {}, p.span));
		w.tip.appendChild(el("div", { "class": "tip-value" }, w.metricLabel + ": " + exact(p.value, w.money)));
		if (p.partial) w.tip.appendChild(el("div", { "class": "tip-note" }, "Partial period: only these dates are counted"));
		w.tip.hidden = false;
		var cx = PAD.l + geo.band * (i + 0.5);
		var left = cx + 14;
		if (left + w.tip.offsetWidth > geo.width) left = cx - 14 - w.tip.offsetWidth;
		w.tip.style.left = Math.max(0, left) + "px";
		w.tip.style.top = "12px";
	}
	function unhover(w) {
		w.tip.hidden = true;
		if (w.hover !== -1) {
			w.hover = -1;
			if (w.points) draw(w);
		}
	}
	function renderDrill(w, i, data) {
		var p = w.points[i];
		w.drill.textContent = "";
		var head = el("div", { "class": "row" });
		head.appendChild(el("strong", {}, "Drill-down: " + p.label + " (" + p.span + ")"));
		var close = el("button", { type: "button", "class": "secondary" }, "Close");
		close.addEventListener("click", function () { w.drill.hidden = true; });
		head.appendChild(close);
		w.drill.appendChild(head);
		var table = el("table");
		var headRow = el("tr");
		["Country", "Plan", "Channel", data.metricLabel].forEach(function (h) { headRow.appendChild(el("th", {}, h)); });
		var thead = el("thead");
		thead.appendChild(headRow);
		table.appendChild(thead);
		var body = el("tbody");
		data.rows.forEach(function (row) {
			var tr = el("tr");
			[row.country, row.plan, row.channel, exact(row.value, data.money)].forEach(function (c) { tr.appendChild(el("td", {}, c)); });
			body.appendChild(tr);
		});
		if (!data.rows.length) {
			var empty = el("tr");
			empty.appendChild(el("td", { colspan: "4", "class": "muted" }, "No activity in this period."));
			body.appendChild(empty);
		}
		table.appendChild(body);
		w.drill.appendChild(table);
		var pager = el("div", { "class": "pager" });
		var prev = el("button", { type: "button", "class": "secondary" }, "Previous");
		prev.disabled = data.page <= 1;
		prev.addEventListener("click", function () { openDrill(w, i, data.page - 1); });
		var next = el("button", { type: "button", "class": "secondary" }, "Next");
		next.disabled = data.page >= data.pages;
		next.addEventListener("click", function () { openDrill(w, i, data.page + 1); });
		pager.appendChild(prev);
		pager.appendChild(el("span", { "class": "muted" }, "Page " + data.page + " of " + data.pages + " · " + data.total + " segments"));
		pager.appendChild(next);
		w.drill.appendChild(pager);
		w.drill.hidden = false;
	}
	function openDrill(w, i, pageNo) {
		var p = w.points[i];
		var q = new URLSearchParams(params({ metric: w.metric, page: String(pageNo) }));
		q.delete("group");
		if (w.kind === "series") {
			q.set("from", p.start);
			q.set("to", p.end);
		} else {
			q.set(PARAM[w.by], p.key);
		}
		var token = w.token;
		fetch("/api/drill?" + q.toString())
			.then(function (r) { return r.json(); })
			.then(function (data) { if (token === w.token && !data.error) renderDrill(w, i, data); });
	}
	function schedule(w) {
		if (!w.visible || !w.stale || w.timer) return;
		w.timer = setTimeout(function () { w.timer = 0; load(w); }, LOAD_DELAY_MS);
	}
	function load(w) {
		w.stale = false;
		var token = ++w.token;
		var url = w.kind === "series"
			? "/api/series?" + params({ metric: w.metric })
			: "/api/breakdown?" + params({ metric: w.metric, by: w.by });
		fetch(url)
			.then(function (r) { return r.json(); })
			.then(function (data) {
				if (token !== w.token) return;
				if (data.error) { w.loading.textContent = data.error; return; }
				w.points = data.points;
				w.money = data.money;
				w.metricLabel = data.metricLabel;
				w.note.textContent = data.note;
				w.loading.hidden = true;
				draw(w);
				w.exportLink.href = "/export.csv?" + params({ widget: w.id });
				w.exportLink.removeAttribute("aria-disabled");
				w.el.setAttribute("data-state", "ready");
			})
			.catch(function () {
				if (token !== w.token) return;
				w.stale = true;
				w.loading.textContent = "Could not load. Scroll away and back to retry.";
			});
	}
	function reset(w) {
		w.token++;
		w.points = null;
		w.hover = -1;
		w.stale = true;
		if (w.timer) { clearTimeout(w.timer); w.timer = 0; }
		w.el.setAttribute("data-state", "loading");
		w.loading.textContent = "Loading…";
		w.loading.hidden = false;
		w.tip.hidden = true;
		w.note.textContent = "";
		w.exportLink.removeAttribute("href");
		w.exportLink.setAttribute("aria-disabled", "true");
		w.drill.hidden = true;
		w.drill.textContent = "";
		draw(w);
		schedule(w);
	}
	document.querySelectorAll(".widget").forEach(function (node) {
		var w = {
			el: node, id: node.dataset.widget, metric: node.dataset.metric, kind: node.dataset.kind,
			by: node.dataset.by || "", chart: node.dataset.chart,
			canvas: node.querySelector("canvas"), tip: node.querySelector(".tooltip"), loading: node.querySelector(".loading"),
			exportLink: node.querySelector(".export"), drill: node.querySelector(".drill"), note: node.querySelector(".note"),
			points: null, money: false, metricLabel: "", visible: false, stale: true, timer: 0, token: 0, hover: -1
		};
		widgets.push(w);
		w.canvas.addEventListener("mousemove", function (e) { hover(w, e); });
		w.canvas.addEventListener("mouseleave", function () { unhover(w); });
		w.canvas.addEventListener("click", function (e) {
			var i = indexAt(w, e);
			if (i >= 0) openDrill(w, i, 1);
		});
		w.exportLink.addEventListener("click", function (e) {
			if (w.exportLink.getAttribute("aria-disabled") === "true") e.preventDefault();
		});
	});
	var observer = new IntersectionObserver(function (entries) {
		entries.forEach(function (entry) {
			var w = widgets.filter(function (x) { return x.el === entry.target; })[0];
			w.visible = entry.isIntersecting;
			if (w.visible) schedule(w);
			else if (w.timer) { clearTimeout(w.timer); w.timer = 0; }
		});
	});
	widgets.forEach(function (w) { observer.observe(w.el); });
	window.addEventListener("resize", function () { widgets.forEach(function (w) { if (w.points) draw(w); }); });

	// ---- saving the view as a report
	var dialog = document.getElementById("report-dialog");
	var nameInput = document.getElementById("report-name");
	var metricSelect = document.getElementById("report-metric");
	var reportError = document.getElementById("report-error");
	var saveButton = document.getElementById("report-save");
	function closeDialog() { dialog.hidden = true; }
	document.getElementById("save-report").addEventListener("click", function (e) {
		e.stopPropagation();
		closePicker();
		var parts = DIMS.filter(function (d) { return state[d].length; }).map(function (d) {
			return B.titles[d] + ": " + state[d].map(function (id) { return labelOf(d, id); }).join(", ");
		});
		document.getElementById("report-summary").textContent =
			shortDate(state.from) + " – " + shortDate(state.to) + " · " + B.groupLabels[state.group] + " · " +
			(parts.length ? parts.join(" · ") : "No filters");
		reportError.textContent = "";
		dialog.hidden = false;
		nameInput.focus();
	});
	document.getElementById("report-cancel").addEventListener("click", closeDialog);
	document.addEventListener("keydown", function (e) {
		if (e.key !== "Escape") return;
		closePicker();
		closeDialog();
	});
	saveButton.addEventListener("click", function () {
		saveButton.disabled = true;
		reportError.textContent = "";
		var body = {
			name: nameInput.value, metric: metricSelect.value, from: state.from, to: state.to, group: state.group,
			countries: state.countries, plans: state.plans, channels: state.channels
		};
		fetch("/api/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
			.then(function (r) { return r.json(); })
			.then(function (data) {
				saveButton.disabled = false;
				if (data.error) { reportError.textContent = data.error; return; }
				closeDialog();
				nameInput.value = "";
				var notice = document.getElementById("saved-notice");
				notice.textContent = "Saved report “" + data.name + "”. It is listed under Saved reports.";
				notice.hidden = false;
			})
			.catch(function () {
				saveButton.disabled = false;
				reportError.textContent = "The report could not be saved. Try again.";
			});
	});

	renderControls();
})();
`;

export const ALERTS_SCRIPT = String.raw`
(function () {
	"use strict";
	var dialog = document.getElementById("alert-dialog");
	var error = document.getElementById("alert-error");
	var recipient = document.getElementById("alert-recipient");
	var save = document.getElementById("alert-save");
	var picked = { countries: [], plans: [], channels: [] };
	var HINTS = { email: "name@example.com", slack: "#channel-name", webhook: "https://…" };
	document.getElementById("new-alert").addEventListener("click", function () {
		error.textContent = "";
		dialog.hidden = false;
		document.getElementById("alert-name").focus();
	});
	document.getElementById("alert-cancel").addEventListener("click", function () { dialog.hidden = true; });
	document.addEventListener("keydown", function (e) { if (e.key === "Escape") dialog.hidden = true; });
	dialog.querySelectorAll(".chips").forEach(function (box) {
		box.addEventListener("click", function (e) {
			var chip = e.target.closest(".chip");
			if (!chip) return;
			var list = picked[box.dataset.dim], at = list.indexOf(chip.dataset.value);
			if (at >= 0) list.splice(at, 1);
			else list.push(chip.dataset.value);
			chip.setAttribute("aria-pressed", String(at < 0));
		});
	});
	dialog.querySelectorAll("input[name=notify]").forEach(function (radio) {
		radio.addEventListener("change", function () { recipient.placeholder = HINTS[radio.value]; });
	});
	save.addEventListener("click", function () {
		var notify = dialog.querySelector("input[name=notify]:checked");
		var body = {
			name: document.getElementById("alert-name").value,
			metric: document.getElementById("alert-metric").value,
			condition: document.getElementById("alert-condition").value,
			threshold: document.getElementById("alert-threshold").value,
			countries: picked.countries, plans: picked.plans, channels: picked.channels,
			notify: notify ? notify.value : "",
			recipient: recipient.value
		};
		save.disabled = true;
		error.textContent = "";
		fetch("/api/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
			.then(function (r) { return r.json(); })
			.then(function (data) {
				save.disabled = false;
				if (data.error) { error.textContent = data.error; return; }
				location.href = "/alerts?created=" + encodeURIComponent(data.id);
			})
			.catch(function () {
				save.disabled = false;
				error.textContent = "The rule could not be saved. Try again.";
			});
	});
})();
`;
