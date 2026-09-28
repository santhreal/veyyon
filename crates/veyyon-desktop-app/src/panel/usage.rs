//! The usage tab: what the displayed session spent, how full its context
//! window is and what it is made of, and the subscription quota of the login
//! serving it.

use veyyon_desktop_model::{
	ContextBreakdownView, HostAction, HostActionKind, QuotaView, QuotaWindowView, SessionId,
	SurfaceId, UsageTotals,
};
use veyyon_desktop_ui::theme::{Palette, TypeStyled, radius, space, text};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, Hsla, IntoElement, ParentElement, SharedString, Styled,
	div, prelude::*, relative,
};

use super::{
	RightPanel,
	style::{empty_state, heading, now_ms, refresh_control, span, toolbar},
};

/// The tab's body.
pub fn render(panel: &RightPanel, palette: &Palette, cx: &mut Context<RightPanel>) -> AnyElement {
	let app = panel.app.read(cx);
	let Some(session) = app.active_session().cloned() else {
		return empty_state("Open a session to see what it spent", None::<Div>, palette)
			.into_any_element();
	};
	let domains = &app.store().domains;
	let pending = app.panel_pending(HostActionKind::GetUsage)
		|| app.panel_pending(HostActionKind::GetContextBreakdown);
	let usage_refused = app.panel_unavailable(HostActionKind::GetUsage);
	let context_refused = app.panel_unavailable(HostActionKind::GetContextBreakdown);
	// The control asks for both halves, so it is refused only while both are.
	let refused = usage_refused.clone().filter(|_| context_refused.is_some());
	let refresh = refresh_control(
		"usage-refresh",
		"Count the usage again",
		pending,
		refused,
		cx.listener(move |this, _: &ClickEvent, _, cx| this.refresh_usage(&session, cx)),
	);
	let session = app.active_session();
	let totals = session.and_then(|session| domains.usage.get(session));
	let context = session.and_then(|session| domains.context.get(session));
	let quota = session.and_then(|session| app.store().quota(session));
	div()
		.flex()
		.flex_col()
		.size_full()
		.child(
			toolbar(palette)
				.px(space::S3)
				.child(div().flex_1().type_style(text::UI_MEDIUM).child("Usage"))
				.child(refresh),
		)
		.child(
			div()
				.id("usage-body")
				.flex()
				.flex_col()
				.flex_1()
				.min_h_0()
				.overflow_y_scroll()
				.pb(space::S3)
				.child(heading("Spent", palette))
				.child(match (totals, usage_refused) {
					(Some(totals), _) => figures(totals, palette),
					(None, Some(reason)) => note(reason, palette),
					(None, None) => note("The host has not counted this session yet", palette),
				})
				.child(heading("Context window", palette))
				.child(match (context, context_refused) {
					(Some(context), _) => context_rows(context, palette),
					(None, Some(reason)) => note(reason, palette),
					(None, None) => note("The host has not measured the context yet", palette),
				})
				.children(quota.map(|quota| quota_rows(quota, palette))),
		)
		.into_any_element()
}

impl RightPanel {
	/// Asks the host for the displayed session's totals and context window,
	/// each by the capability that answers it: a host that declines one is
	/// still asked for the other, and neither is asked while one is in
	/// flight.
	pub(super) fn refresh_usage(&mut self, session: &SessionId, cx: &mut Context<Self>) {
		let halves = [
			(HostAction::GetUsage { session: Some(session.clone()) }, SurfaceId::UsageRefreshButton),
			(
				HostAction::GetContextBreakdown { session: session.clone() },
				SurfaceId::ContextBreakdownRefreshButton,
			),
		];
		for (action, surface) in halves {
			let app = self.app.read(cx);
			let kind = action.kind();
			if !app.panel_pending(kind) && app.panel_unavailable(kind).is_none() {
				self.send(action, surface, cx);
			}
		}
	}
}

/// A muted sentence in place of figures the host has not sent.
fn note(copy: impl Into<SharedString>, palette: &Palette) -> Div {
	div()
		.px(space::S3)
		.py(space::S1)
		.type_style(text::SMALL)
		.text_color(palette.text.muted)
		.child(copy.into())
}

/// Groups the digits of a count so two figures can be compared.
fn grouped(count: u64) -> String {
	let digits = count.to_string();
	let mut out = String::with_capacity(digits.len() + digits.len() / 3);
	for (ix, digit) in digits.chars().enumerate() {
		if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
			out.push(',');
		}
		out.push(digit);
	}
	out
}

/// One label and its figure, the figure right-aligned in tabular digits.
fn figure(label: &str, value: String, palette: &Palette) -> Div {
	div()
		.flex()
		.items_center()
		.px(space::S3)
		.py(space::S0_5)
		.type_style(text::UI)
		.child(
			div()
				.flex_1()
				.text_color(palette.text.secondary)
				.child(label.to_owned()),
		)
		.child(
			div()
				.type_style(text::MONO)
				.text_color(palette.text.primary)
				.child(value),
		)
}

/// The seven totals, in the order they are read: what went in, what came
/// back, what was reused, what it was charged as, and what it cost.
fn figures(totals: &UsageTotals, palette: &Palette) -> Div {
	let cost = totals
		.cost_microusd
		.map_or_else(|| "\u{2014}".to_owned(), |micro| format!("${:.4}", micro as f64 / 1_000_000.0));
	div()
		.flex()
		.flex_col()
		.child(figure("Input", grouped(totals.input_tokens), palette))
		.child(figure("Output", grouped(totals.output_tokens), palette))
		.child(figure("Cache read", grouped(totals.cache_read_tokens), palette))
		.child(figure("Cache write", grouped(totals.cache_write_tokens), palette))
		.child(figure("Orchestration", grouped(totals.orchestration_tokens), palette))
		.child(figure("Premium requests", grouped(u64::from(totals.premium_requests)), palette))
		.child(figure("Cost", cost, palette))
}

/// A horizontal bar filled to `share` of its width.
fn meter(share: f32, fill: Hsla, palette: &Palette) -> Div {
	div()
		.mx(space::S3)
		.my(space::S1)
		.h(space::S1)
		.rounded(radius::FULL)
		.bg(palette.bg.hover)
		.child(
			div()
				.h_full()
				.w(relative(share.clamp(0.0, 1.0)))
				.rounded(radius::FULL)
				.bg(fill),
		)
}

/// How full the window is, then each category's share of what it holds.
fn context_rows(context: &ContextBreakdownView, palette: &Palette) -> Div {
	let used = match context.limit_tokens {
		Some(limit) if limit > 0 => format!(
			"{} of {} ({:.0}%)",
			grouped(context.total_tokens),
			grouped(limit),
			context.total_tokens as f64 * 100.0 / limit as f64
		),
		_ => grouped(context.total_tokens),
	};
	let share = context
		.limit_tokens
		.filter(|&limit| limit > 0)
		.map(|limit| context.total_tokens as f32 / limit as f32);
	let total = context.total_tokens.max(1) as f32;
	div()
		.flex()
		.flex_col()
		.child(figure("Used", used, palette))
		.children(share.map(|share| meter(share, palette.accent.base, palette)))
		.children(context.categories.iter().map(|category| {
			div()
				.flex()
				.flex_col()
				.child(figure(&category.name, grouped(category.tokens), palette))
				.child(meter(category.tokens as f32 / total, palette.text.muted, palette))
		}))
}

/// The quota tier and the two rolling windows.
fn quota_rows(quota: &QuotaView, palette: &Palette) -> Div {
	let now = now_ms();
	let window = |label: &'static str, window: &QuotaWindowView| {
		let share = window.used_permille as f32 / 1000.0;
		let fill = if window.used_permille >= 900 {
			palette.status.error
		} else {
			palette.accent.base
		};
		let resets = window
			.resets_at_ms
			.map(|at| format!(", resets in {}", span(at.saturating_sub(now))));
		div()
			.flex()
			.flex_col()
			.child(figure(
				label,
				format!(
					"{}.{}%{}",
					window.used_permille / 10,
					window.used_permille % 10,
					resets.unwrap_or_default()
				),
				palette,
			))
			.child(meter(share, fill, palette))
	};
	div()
		.flex()
		.flex_col()
		.child(heading("Subscription quota", palette))
		.children(quota.tier.clone().map(|tier| figure("Plan", tier, palette)))
		.children(
			quota
				.five_hour
				.as_ref()
				.map(|five| window("Five hours", five)),
		)
		.children(
			quota
				.seven_day
				.as_ref()
				.map(|seven| window("Seven days", seven)),
		)
}
