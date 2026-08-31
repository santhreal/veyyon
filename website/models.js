/**
 * Models catalog page: fetch the generated models-data.json and render a
 * searchable, filterable, provider-grouped list of every model veyyon supports.
 *
 * Auto-refresh: the page fetches from jsDelivr's @main mirror of this repo, so
 * a catalog regen committed to main shows up within jsDelivr's cache window
 * with no site deploy. If that fails (offline, jsDelivr down), it falls back to
 * the same-origin copy staged by build.mjs.
 */
(function () {
	"use strict";

	var JSDELIVR = "https://cdn.jsdelivr.net/gh/santhreal/veyyon@main/website/models-data.json";
	var LOCAL = "./models-data.json";

	var state = { data: null, query: "", filters: new Set() };
	var els = {};

	function $(id) {
		return document.getElementById(id);
	}

	function fmtCtx(n) {
		if (n == null) return "—";
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
		if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "K";
		return String(n);
	}

	function fmtCost(c) {
		if (c === 0) return "free";
		if (c < 0.01) return "<$0.01";
		if (c < 1) return "$" + c.toFixed(2);
		return "$" + c.toFixed(2);
	}

	function esc(s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function matchesFilters(model) {
		if (state.filters.has("reasoning") && !model.r) return false;
		if (state.filters.has("vision") && !(model.i && model.i.indexOf("image") !== -1)) return false;
		if (state.filters.has("free") && (model.ci !== 0 || model.co !== 0)) return false;
		return true;
	}

	function matchesQuery(model, providerLabel) {
		if (!state.query) return true;
		var q = state.query.toLowerCase();
		return (
			model.id.toLowerCase().indexOf(q) !== -1 ||
			(model.name && model.name.toLowerCase().indexOf(q) !== -1) ||
			providerLabel.toLowerCase().indexOf(q) !== -1
		);
	}

	function renderModelRow(m) {
		var badges = "";
		if (m.r) badges += '<span class="mb mb-r" title="Reasoning">R</span>';
		if (m.i && m.i.indexOf("image") !== -1) badges += '<span class="mb mb-v" title="Vision">V</span>';
		var ctx = fmtCtx(m.ctx);
		var ci = fmtCost(m.ci);
		var co = fmtCost(m.co);
		return (
			'<tr class="mrow"><td class="m-name">' +
			esc(m.name) +
			' <span class="m-id">' +
			esc(m.id) +
			"</span></td><td>" +
			badges +
			'</td><td class="m-num">' +
			ctx +
			'</td><td class="m-num">' +
			ci +
			'</td><td class="m-num">' +
			co +
			"</td></tr>"
		);
	}

	function renderProvider(p, modelFilter) {
		var models = p.models.filter(modelFilter);
		// A hosted provider matches if any of its models match. A local provider
		// has no models to filter, so it matches when the query is empty or its
		// label contains the query — the same rule the search box applies to
		// hosted provider names.
		if (!p.local && models.length === 0) return null;
		if (p.local && state.query && p.label.toLowerCase().indexOf(state.query.toLowerCase()) === -1) return null;

	var header =
		'<div class="cat-prov-head" role="button" tabindex="0" aria-expanded="false">' +
		'<span class="cat-prov-name">' +
		esc(p.label) +
		"</span>" +
		'<span class="cat-prov-count">' +
		(p.local ? "local" : models.length + (p.count === models.length ? "" : "/" + p.count)) +
		"</span>" +
		'<span class="cat-prov-chevron" aria-hidden="true">+</span>' +
		"</div>";

		var body;
		if (p.local) {
			body =
				'<div class="cat-prov-body" hidden><p class="cat-local">Local / self-hosted. Models are discovered at runtime from the server running on your machine. Set ' +
				esc(p.envVar || p.id.toUpperCase().replace(/-/g, "_") + "_API_KEY") +
				" or start the server.</p></div>";
		} else {
			var rows = models.map(renderModelRow).join("");
			body =
				'<div class="cat-prov-body" hidden><table class="cat-tbl"><thead><tr>' +
				"<th>Model</th><th></th><th>Context</th><th>In $/M</th><th>Out $/M</th>" +
				"</tr></thead><tbody>" +
				rows +
				"</tbody></table></div>";
		}

		return '<div class="cat-prov" data-pid="' + esc(p.id) + '">' + header + body + "</div>";
	}

	function render() {
		if (!state.data) return;
		var d = state.data;

		function modelFilter(m) {
			return matchesFilters(m) && matchesQuery(m, "");
		}

		var provFilter = function (p) {
			if (p.local) return state.query === "" || p.label.toLowerCase().indexOf(state.query.toLowerCase()) !== -1;
			return p.models.some(function (m) {
				return matchesFilters(m) && matchesQuery(m, p.label);
			});
		};

		var html = d.providers.map(function (p) {
			return renderProvider(p, function (m) {
				return matchesFilters(m) && matchesQuery(m, p.label);
			});
		});
		// renderProvider returns null for a provider whose models all fail the filter.
		var visible = html.filter(function (h) {
			return h !== null;
		});

		els.catalog.innerHTML = visible.join("") || '<p class="cat-empty">No models match your search.</p>';

		// Wire collapsible headers.
		var heads = els.catalog.querySelectorAll(".cat-prov-head");
		for (var i = 0; i < heads.length; i++) {
			heads[i].addEventListener("click", toggleProvider);
			heads[i].addEventListener("keydown", function (e) {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					toggleProvider(e);
				}
			});
		}

		// Meta line.
		var totalShown = 0;
		d.providers.forEach(function (p) {
			if (!p.local) totalShown += p.models.filter(modelFilter).length;
		});
		els.meta.textContent =
			d.providerCount + " providers · " + totalShown + " of " + d.modelCount + " models · catalog " + d.generated;
	}

	function toggleProvider(e) {
		var head = e.currentTarget;
		var body = head.nextElementSibling;
		var expanded = head.getAttribute("aria-expanded") === "true";
		head.setAttribute("aria-expanded", String(!expanded));
		body.hidden = expanded;
		head.querySelector(".cat-prov-chevron").textContent = expanded ? "+" : "−";
	}

	function toggleFilter(name) {
		if (state.filters.has(name)) state.filters.delete(name);
		else state.filters.add(name);
		var btn = document.querySelector('[data-filter="' + name + '"]');
		if (btn) btn.setAttribute("aria-pressed", String(state.filters.has(name)));
		render();
	}

	async function loadData() {
		// Try jsDelivr @main first (auto-refresh), fall back to same-origin.
		for (var _i = 0, _urls = [JSDELIVR, LOCAL]; _i < _urls.length; _i++) {
			var url = _urls[_i];
			try {
				var res = await fetch(url);
				if (res.ok) {
					state.data = await res.json();
					els.controls.hidden = false;
					els.loading.remove();
					render();
					return;
				}
			} catch (err) {
				// try next source
			}
		}
		els.loading.textContent = "Could not load the model catalog. The raw data is at " + LOCAL + ".";
	}

	function init() {
		els.catalog = $("catalog");
		els.controls = $("cat-controls");
		els.loading = $("cat-loading");
		els.meta = $("cat-meta");
		els.search = $("cat-q");

		if (!els.catalog) return;

		els.search.addEventListener("input", function () {
			state.query = els.search.value.trim();
			render();
		});

		var chips = document.querySelectorAll(".cat-chip");
		for (var i = 0; i < chips.length; i++) {
			(function (chip) {
				chip.addEventListener("click", function () {
					toggleFilter(chip.getAttribute("data-filter"));
				});
			})(chips[i]);
		}

		loadData();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
