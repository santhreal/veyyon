/**
 * Metricly's pages and endpoints over one {@link AnalyticsWorld}: a dashboard whose charts are drawn
 * on canvas and load when scrolled into view, a custom date-range picker, segment chips, drill-down
 * tables, CSV exports the server logs, saved reports and alert rules.
 */

import { Seeded } from "../../../../engine/kit/seeded";
import {
	escapeHtml,
	type HostedSite,
	hostSite,
	html,
	json,
	jsonBody,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { page } from "../../ui";
import {
	type AlertRule,
	type AnalyticsWorld,
	breakdownOf,
	CONDITIONS,
	type Condition,
	csvOf,
	describeCondition,
	describeFilters,
	DIMENSION_KEYS,
	DIMENSIONS,
	type DimensionKey,
	drillRows,
	type ExportLog,
	GROUPING_LABELS,
	GROUPINGS,
	isGrouping,
	isIsoDate,
	isMetricId,
	METRIC_BY_ID,
	METRICS,
	type MetricId,
	NOTIFY_CHANNELS,
	type NotifyChannel,
	presetsOf,
	type SavedReport,
	seriesOf,
	shortDate,
	type View,
} from "./data";
import { ALERTS_SCRIPT, DASHBOARD_SCRIPT } from "./scripts";

export interface AnalyticsSnapshot {
	readonly reports: readonly SavedReport[];
	readonly alerts: readonly AlertRule[];
	readonly exports: readonly ExportLog[];
}

export interface AnalyticsSite extends HostedSite {
	finish(): Promise<AnalyticsSnapshot>;
}

interface Widget {
	readonly id: string;
	readonly title: string;
	readonly metric: MetricId;
	readonly chart: "line" | "bar";
	/** Set for a breakdown: one bar per value of this dimension over the whole range. */
	readonly by?: DimensionKey;
}

const WIDGETS: readonly Widget[] = [
	{ id: "signups", title: "Signups", metric: "signups", chart: "line" },
	{ id: "active-users", title: "Active users", metric: "dau", chart: "line" },
	{ id: "revenue", title: "Revenue", metric: "revenue", chart: "bar" },
	{ id: "revenue-by-channel", title: "Revenue by channel", metric: "revenue", chart: "bar", by: "channels" },
	{ id: "churn", title: "Churned accounts", metric: "churn", chart: "line" },
	{ id: "signups-by-plan", title: "Signups by plan", metric: "signups", chart: "bar", by: "plans" },
];

const DRILL_PAGE_SIZE = 10;

const STYLE = `
[hidden]{display:none !important}
header.app .data-through{margin-left:auto;color:#9ca3af}
.toolbar{display:flex;flex-direction:column;gap:10px}
.seg{display:inline-flex;border:1px solid #cbd5e1;border-radius:4px;overflow:hidden}
.seg button{background:#fff;color:#111827;border-radius:0}
.seg button[aria-checked=true]{background:#2563eb;color:#fff}
.chip-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.chip-title{width:70px;color:#6b7280}
.chip{background:#fff;color:#374151;border:1px solid #cbd5e1;border-radius:999px;padding:3px 10px}
.chip[aria-pressed=true]{background:#dbeafe;border-color:#2563eb;color:#1e3a8a}
.link{background:none;color:#2563eb;padding:0;text-decoration:underline}
.picker-anchor{position:relative}
#range-picker{position:absolute;top:38px;left:0;z-index:30;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:12px;display:flex;gap:14px;width:max-content}
.presets{display:flex;flex-direction:column;gap:4px;min-width:130px}
.presets button{background:#f3f4f6;color:#111827;text-align:left}
.presets button[aria-pressed=true]{background:#dbeafe}
.cal-nav{display:flex;justify-content:space-between;margin-bottom:6px}
.months{display:flex;gap:18px}
.month-title{text-align:center;font-weight:600;margin-bottom:6px}
.days{display:grid;grid-template-columns:repeat(7,34px);gap:2px}
.dow{font-size:11px;color:#6b7280;text-align:center}
.day{background:#fff;color:#111827;padding:4px 0;border-radius:4px}
.day:disabled{color:#cbd5e1;background:#fff}
.day.in-range{background:#dbeafe}
.day.edge{background:#2563eb;color:#fff}
.picker-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.widget{min-height:440px}
.widget-head{display:flex;gap:10px;align-items:baseline}
.widget-head h2{font-size:16px;margin:0}
.widget-head .export{margin-left:auto;text-decoration:none}
.export[aria-disabled=true]{opacity:.45;pointer-events:none}
.chart-wrap{position:relative;margin-top:8px}
.chart-wrap canvas{display:block;width:100%;height:280px}
.tooltip{position:absolute;pointer-events:none;background:#111827;color:#fff;padding:6px 9px;border-radius:5px;font-size:12px;min-width:160px;z-index:5}
.loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#6b7280;background:rgba(255,255,255,.85)}
.drill{margin-top:10px}
.pager{display:flex;gap:8px;align-items:center;margin-top:6px}
.dialog{max-height:92vh;overflow:auto}
fieldset{border:1px solid #e5e7eb;border-radius:6px;margin:10px 0;padding:8px}
`;

class RequestError extends Error {}

function field(record: Record<string, unknown>, name: string): string {
	const value = record[name];
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function idList(key: DimensionKey, raw: readonly string[]): string[] {
	const known = DIMENSIONS[key].values.map(value => value.id);
	for (const id of raw) {
		if (!known.includes(id)) throw new RequestError(`Unknown ${DIMENSIONS[key].title.toLowerCase()} "${id}".`);
	}
	return known.filter(id => raw.includes(id));
}

function jsonIds(record: Record<string, unknown>, key: DimensionKey): string[] {
	const value = record[key] ?? [];
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new RequestError(`${key} must be a list of ids.`);
	}
	return idList(key, value as string[]);
}

function viewQuery(view: View): string {
	const query = new URLSearchParams({ from: view.from, to: view.to, group: view.group });
	for (const key of DIMENSION_KEYS) if (view[key].length > 0) query.set(DIMENSIONS[key].param, view[key].join(","));
	return query.toString();
}

export async function startAnalyticsSite(world: AnalyticsWorld, seed: number): Promise<AnalyticsSite> {
	const rng = new Seeded(seed ^ 0xa11e);
	const exports: ExportLog[] = [];

	const date = (value: string | null, name: string): string => {
		if (!value || !isIsoDate(value)) throw new RequestError(`${name} must be a date written YYYY-MM-DD.`);
		if (value < world.start || value > world.today) {
			throw new RequestError(`${name} must fall between ${world.start} and ${world.today}, the days with data.`);
		}
		return value;
	};

	const range = (fromValue: string | null, toValue: string | null): { from: string; to: string } => {
		const from = date(fromValue, "from");
		const to = date(toValue, "to");
		if (from > to) throw new RequestError("The range ends before it starts.");
		return { from, to };
	};

	const viewOf = (url: URL): View => {
		const group = url.searchParams.get("group") ?? "day";
		if (!isGrouping(group)) throw new RequestError("group must be day, week or month.");
		const list = (key: DimensionKey) =>
			idList(
				key,
				(url.searchParams.get(DIMENSIONS[key].param) ?? "")
					.split(",")
					.map(item => item.trim())
					.filter(Boolean),
			);
		return {
			...range(url.searchParams.get("from"), url.searchParams.get("to")),
			group,
			countries: list("countries"),
			plans: list("plans"),
			channels: list("channels"),
		};
	};

	const metricOf = (value: string | null): MetricId => {
		if (!value || !isMetricId(value)) {
			throw new RequestError(`metric must be one of ${METRICS.map(metric => metric.id).join(", ")}.`);
		}
		return value;
	};

	const render = (title: string, body: string, script = ""): SiteResponse =>
		html(
			page(title, body, {
				brand: "Metricly",
				nav: `<a href="/">Dashboard</a><a href="/reports">Saved reports</a><a href="/alerts">Alerts</a><span class="data-through">Data through ${shortDate(world.today)}</span>`,
				style: STYLE,
				script,
			}),
		);

	const chips = (key: DimensionKey, chosen: readonly string[]) =>
		`<div class="chip-row"><span class="chip-title">${DIMENSIONS[key].title}</span><div class="chips" role="group" aria-label="${DIMENSIONS[key].title}" data-dim="${key}">${DIMENSIONS[
			key
		].values
			.map(
				value =>
					`<button type="button" class="chip" data-value="${value.id}" aria-pressed="${chosen.includes(value.id)}">${escapeHtml(value.label)}</button>`,
			)
			.join("")}</div></div>`;

	const widgetCard = (widget: Widget) => `<section class="card widget" data-widget="${widget.id}" data-metric="${widget.metric}" data-kind="${widget.by ? "breakdown" : "series"}" data-chart="${widget.chart}"${widget.by ? ` data-by="${widget.by}"` : ""} data-state="loading" aria-label="${escapeHtml(widget.title)}">
<div class="widget-head"><h2>${escapeHtml(widget.title)}</h2><span class="muted note"></span><a class="button secondary export" download aria-disabled="true">Export CSV</a></div>
<div class="chart-wrap"><canvas aria-label="${escapeHtml(widget.title)} chart. Hover a point to see its value."></canvas><div class="tooltip" role="tooltip" hidden></div><div class="loading">Loading…</div></div>
<div class="drill" hidden></div>
</section>`;

	const dashboard = (view: View, fromDefault: boolean, error: string): SiteResponse => {
		const boot = {
			view,
			start: world.start,
			today: world.today,
			presets: presetsOf(world),
			dims: Object.fromEntries(DIMENSION_KEYS.map(key => [key, DIMENSIONS[key].values])),
			titles: Object.fromEntries(DIMENSION_KEYS.map(key => [key, DIMENSIONS[key].title])),
			groupLabels: GROUPING_LABELS,
		};
		const notice = fromDefault
			? `<div class="notice" id="default-notice">Showing your team's default view: ${escapeHtml(describeFilters(view))}, ${shortDate(view.from)} – ${shortDate(view.to)}. Changing any control replaces it.</div>`
			: "";
		return render(
			"Dashboard · Metricly",
			`<h1>Product dashboard</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<div class="card toolbar">
<div class="row">
<div class="picker-anchor"><button type="button" id="range-button" class="secondary" aria-haspopup="dialog" aria-expanded="false">Date range: <span id="range-label">${shortDate(view.from)} – ${shortDate(view.to)}</span></button>
<div id="range-picker" role="dialog" aria-label="Choose a date range" hidden></div></div>
<span class="muted">Group by</span><div class="seg" role="radiogroup" aria-label="Group by">${GROUPINGS.map(
				group =>
					`<button type="button" role="radio" data-group="${group}" aria-checked="${view.group === group}">${group[0]?.toUpperCase()}${group.slice(1)}</button>`,
			).join("")}</div>
<button type="button" id="save-report" style="margin-left:auto">Save report</button>
</div>
${DIMENSION_KEYS.map(key => chips(key, view[key])).join("\n")}
<div><button type="button" class="link" id="clear-filters">Clear filters</button></div>
</div>
${notice}
<div class="notice" id="saved-notice" hidden></div>
${WIDGETS.map(widgetCard).join("\n")}
<div class="overlay" id="report-dialog" hidden><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
<h2 id="report-title">Save report</h2>
<p class="muted">The report keeps the dashboard's current date range, grouping and filters.</p>
<p id="report-summary"></p>
<label for="report-name">Report name</label><input id="report-name" autocomplete="off" style="width:100%">
<label for="report-metric">Metric</label><select id="report-metric">${METRICS.map(metric => `<option value="${metric.id}">${metric.label}</option>`).join("")}</select>
<p class="error" id="report-error" role="alert"></p>
<div class="row"><button type="button" id="report-save">Save</button><button type="button" class="secondary" id="report-cancel">Cancel</button></div>
</div></div>`,
			`window.__METRICLY__ = ${JSON.stringify(boot).replaceAll("<", "\\u003c")};\n${DASHBOARD_SCRIPT}`,
		);
	};

	const reportsPage = () =>
		render(
			"Saved reports · Metricly",
			`<h1>Saved reports</h1>
<p class="muted">Save a report from the dashboard with <em>Save report</em>; it keeps the range, grouping and filters shown there.</p>
<table><thead><tr><th>Name</th><th>Metric</th><th>Range</th><th>Grouping</th><th>Filters</th><th></th></tr></thead><tbody>
${world.reports
	.map(
		report =>
			`<tr><td>${escapeHtml(report.name)}</td><td>${METRIC_BY_ID[report.metric].label}</td><td>${shortDate(report.from)} – ${shortDate(report.to)}</td><td>${GROUPING_LABELS[report.group]}</td><td>${escapeHtml(describeFilters(report))}</td><td><a href="/?${escapeHtml(viewQuery(report))}">Open</a></td></tr>`,
	)
	.join("\n")}
</tbody></table>`,
		);

	const alertsPage = (created: string | null) => {
		const alertChips = DIMENSION_KEYS.map(key => chips(key, [])).join("\n");
		const fresh = world.alerts.find(alert => alert.id === created);
		return render(
			"Alerts · Metricly",
			`<div class="row" style="justify-content:space-between"><h1>Alert rules</h1><button type="button" id="new-alert">New alert rule</button></div>
${fresh ? `<div class="notice">Created alert rule “${escapeHtml(fresh.name)}”.</div>` : ""}
<p class="muted">A rule is checked once a day against that day's value of its metric for the segments it filters to.</p>
<table><thead><tr><th>Name</th><th>Metric</th><th>Condition</th><th>Filters</th><th>Notifies</th></tr></thead><tbody>
${world.alerts
	.map(
		alert =>
			`<tr><td>${escapeHtml(alert.name)}</td><td>${METRIC_BY_ID[alert.metric].label}</td><td>${escapeHtml(describeCondition(alert.condition, alert.threshold))}</td><td>${escapeHtml(describeFilters(alert))}</td><td>${escapeHtml(NOTIFY_CHANNELS.find(entry => entry.id === alert.notify)?.label ?? alert.notify)}: ${escapeHtml(alert.recipient)}</td></tr>`,
	)
	.join("\n")}
</tbody></table>
<div class="overlay" id="alert-dialog" hidden><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="alert-title">
<h2 id="alert-title">New alert rule</h2>
<label for="alert-name">Name</label><input id="alert-name" autocomplete="off" style="width:100%">
<label for="alert-metric">Metric</label><select id="alert-metric">${METRICS.map(metric => `<option value="${metric.id}">${metric.label}</option>`).join("")}</select>
<label for="alert-condition">Condition</label><select id="alert-condition">${CONDITIONS.map(condition => `<option value="${condition.id}">${condition.label}</option>`).join("")}</select>
<label for="alert-threshold">Threshold (X)</label><input id="alert-threshold" inputmode="decimal" autocomplete="off">
<fieldset><legend>Segment filters (none selected means every segment)</legend>
${alertChips}
</fieldset>
<fieldset><legend>Notify via</legend><div class="row">${NOTIFY_CHANNELS.map(
				(channel, index) =>
					`<label style="margin:0"><input type="radio" name="notify" value="${channel.id}"${index === 0 ? " checked" : ""}> ${channel.label}</label>`,
			).join("")}</div></fieldset>
<label for="alert-recipient">Recipient</label><input id="alert-recipient" placeholder="name@example.com" autocomplete="off" style="width:100%">
<p class="error" id="alert-error" role="alert"></p>
<div class="row"><button type="button" id="alert-save">Save rule</button><button type="button" class="secondary" id="alert-cancel">Cancel</button></div>
</div></div>`,
			ALERTS_SCRIPT,
		);
	};

	const note = (metric: MetricId, group: string, breakdown: boolean): string => {
		const mean = METRIC_BY_ID[metric].aggregate === "mean";
		if (breakdown) return mean ? "Average per day over the range" : "Total over the range";
		if (group === "day") return mean ? "Per day" : "Daily totals";
		return mean ? `Average per day, by ${group}` : `Totals by ${group}`;
	};

	const seriesResponse = (url: URL): SiteResponse => {
		const metric = metricOf(url.searchParams.get("metric"));
		const view = viewOf(url);
		return json({
			metric,
			metricLabel: METRIC_BY_ID[metric].label,
			money: METRIC_BY_ID[metric].money,
			note: note(metric, view.group, false),
			points: seriesOf(world, metric, view),
		});
	};

	const breakdownResponse = (url: URL): SiteResponse => {
		const metric = metricOf(url.searchParams.get("metric"));
		const by = url.searchParams.get("by") ?? "";
		if (!(DIMENSION_KEYS as readonly string[]).includes(by)) {
			throw new RequestError("by must be countries, plans or channels.");
		}
		const view = viewOf(url);
		return json({
			metric,
			metricLabel: METRIC_BY_ID[metric].label,
			money: METRIC_BY_ID[metric].money,
			note: note(metric, view.group, true),
			points: breakdownOf(world, metric, by as DimensionKey, view),
		});
	};

	const drillResponse = (url: URL): SiteResponse => {
		const metric = metricOf(url.searchParams.get("metric"));
		const view = viewOf(url);
		const rows = drillRows(world, metric, view, view.from, view.to);
		const pages = Math.max(1, Math.ceil(rows.length / DRILL_PAGE_SIZE));
		const pageNumber = Math.min(pages, Math.max(1, Math.floor(Number(url.searchParams.get("page") || "1")) || 1));
		return json({
			metricLabel: METRIC_BY_ID[metric].label,
			money: METRIC_BY_ID[metric].money,
			page: pageNumber,
			pages,
			total: rows.length,
			rows: rows.slice((pageNumber - 1) * DRILL_PAGE_SIZE, pageNumber * DRILL_PAGE_SIZE),
		});
	};

	const exportResponse = (url: URL): SiteResponse => {
		const widget = WIDGETS.find(entry => entry.id === url.searchParams.get("widget"));
		if (!widget) throw new RequestError(`widget must be one of ${WIDGETS.map(entry => entry.id).join(", ")}.`);
		const view = viewOf(url);
		exports.push({
			widget: widget.id,
			metric: widget.metric,
			by: widget.by ?? null,
			from: view.from,
			to: view.to,
			group: view.group,
			countries: view.countries,
			plans: view.plans,
			channels: view.channels,
		});
		const body = widget.by
			? csvOf(widget.metric, DIMENSIONS[widget.by].param, breakdownOf(world, widget.metric, widget.by, view))
			: csvOf(widget.metric, view.group, seriesOf(world, widget.metric, view));
		return {
			status: 200,
			headers: {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": `attachment; filename="metricly-${widget.id}-${view.from}-to-${view.to}.csv"`,
			},
			body,
		};
	};

	const createReport = (request: SiteRequest): SiteResponse => {
		const input = jsonBody(request);
		if (typeof input !== "object" || input === null) throw new RequestError("Send the report as JSON.");
		const record = input as Record<string, unknown>;
		const name = field(record, "name").trim();
		if (!name) throw new RequestError("Give the report a name.");
		if (name.length > 80) throw new RequestError("A report name is at most 80 characters.");
		if (world.reports.some(report => report.name.toLowerCase() === name.toLowerCase())) {
			throw new RequestError(`A report named “${name}” already exists.`);
		}
		const group = field(record, "group");
		if (!isGrouping(group)) throw new RequestError("group must be day, week or month.");
		const report: SavedReport = {
			id: `rpt-${rng.code(8).toLowerCase()}`,
			name,
			metric: metricOf(field(record, "metric")),
			...range(field(record, "from"), field(record, "to")),
			group,
			countries: jsonIds(record, "countries"),
			plans: jsonIds(record, "plans"),
			channels: jsonIds(record, "channels"),
			seeded: false,
		};
		world.reports.push(report);
		return json({ ok: true, id: report.id, name: report.name });
	};

	const createAlert = (request: SiteRequest): SiteResponse => {
		const input = jsonBody(request);
		if (typeof input !== "object" || input === null) throw new RequestError("Send the rule as JSON.");
		const record = input as Record<string, unknown>;
		const name = field(record, "name").trim();
		if (!name) throw new RequestError("Give the rule a name.");
		const condition = field(record, "condition");
		if (!CONDITIONS.some(entry => entry.id === condition)) throw new RequestError("Choose a condition.");
		const rawThreshold = field(record, "threshold").trim();
		const threshold = Number(rawThreshold);
		if (!rawThreshold || !Number.isFinite(threshold)) throw new RequestError("The threshold must be a number.");
		if ((condition === "drop-pct" || condition === "rise-pct") && (threshold <= 0 || threshold >= 100)) {
			throw new RequestError("A percentage threshold must be more than 0 and less than 100.");
		}
		const notify = field(record, "notify");
		const recipient = field(record, "recipient").trim();
		if (notify === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
			throw new RequestError("Email alerts need a valid email address.");
		}
		if (notify === "slack" && !/^#[a-z0-9][a-z0-9_-]*$/.test(recipient)) {
			throw new RequestError("Slack alerts need a channel such as #alerts.");
		}
		if (notify === "webhook" && !/^https:\/\/\S+$/.test(recipient)) {
			throw new RequestError("Webhooks need an https:// URL.");
		}
		if (!NOTIFY_CHANNELS.some(entry => entry.id === notify)) throw new RequestError("Choose how the rule notifies.");
		const alert: AlertRule = {
			id: `alr-${rng.code(8).toLowerCase()}`,
			name,
			metric: metricOf(field(record, "metric")),
			condition: condition as Condition,
			threshold,
			countries: jsonIds(record, "countries"),
			plans: jsonIds(record, "plans"),
			channels: jsonIds(record, "channels"),
			notify: notify as NotifyChannel,
			recipient,
			seeded: false,
		};
		world.alerts.push(alert);
		return json({ ok: true, id: alert.id });
	};

	const route = (request: SiteRequest): SiteResponse => {
		const { method, url } = request;
		const { pathname } = url;
		if (pathname === "/" && method === "GET") {
			if (url.search === "") return dashboard(world.defaultView, true, "");
			try {
				return dashboard(viewOf(url), false, "");
			} catch (error) {
				if (!(error instanceof RequestError)) throw error;
				return dashboard(world.defaultView, false, error.message);
			}
		}
		if (pathname === "/reports" && method === "GET") return reportsPage();
		if (pathname === "/alerts" && method === "GET") return alertsPage(url.searchParams.get("created"));
		if (pathname === "/api/series" && method === "GET") return seriesResponse(url);
		if (pathname === "/api/breakdown" && method === "GET") return breakdownResponse(url);
		if (pathname === "/api/drill" && method === "GET") return drillResponse(url);
		if (pathname === "/export.csv" && method === "GET") return exportResponse(url);
		if (pathname === "/api/reports" && method === "POST") return createReport(request);
		if (pathname === "/api/alerts" && method === "POST") return createAlert(request);
		return text("Not found", { status: 404 });
	};

	const site = await hostSite(request => {
		try {
			return route(request);
		} catch (error) {
			if (!(error instanceof RequestError)) throw error;
			return request.url.pathname.startsWith("/api/")
				? json({ error: error.message }, { status: 400 })
				: text(error.message, { status: 400 });
		}
	});

	return {
		origin: site.origin,
		close: () => site.close(),
		async finish() {
			await site.close();
			return { reports: world.reports, alerts: world.alerts, exports };
		},
	};
}
