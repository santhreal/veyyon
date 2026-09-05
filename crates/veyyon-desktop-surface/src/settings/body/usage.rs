//! Usage and costs settings page body rendering (§5.9).

use veyyon_desktop_kit::{
	Badge, Button, ButtonSize, ColorRole, RadiusStep, Table, TableColumn, TintRole, TokenSet,
};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, Div, IntoElement, ParentElement, Styled, TextAlign, div};

use crate::{
	Intent, ShellView,
	controls::ControlStates,
	settings::{
		SettingsState,
		row::{empty_state_row, setting_row},
	},
};

fn format_number(n: u64) -> String {
	let s = n.to_string();
	let mut result = String::new();
	let len = s.len();
	for (i, c) in s.chars().enumerate() {
		if i > 0 && (len - i).is_multiple_of(3) {
			result.push(',');
		}
		result.push(c);
	}
	result
}

/// Renders the Usage metrics and financial accounting page rows.
pub fn render_usage_page(
	state: &SettingsState,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	let Some(totals) = &state.usage else {
		return container.child(empty_state_row(
			"No usage data recorded for active session.",
			geometry,
			tokens,
		));
	};

	let av = controls.availability(&SurfaceId::UsageRefreshButton);

	// Refresh action row
	let refresh_btn = Button::new("Refresh")
		.id("usage-refresh-btn")
		.size(ButtonSize::Small)
		.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
			view.dispatch(Intent::RefreshUsage);
			cx.notify();
		}));
	container = container.child(setting_row(
		"Usage Metrics",
		Some("Accumulated token consumption and session accounting"),
		refresh_btn,
		&av,
		geometry,
		tokens,
	));

	// Cost total
	let cost_str = totals
		.cost_microusd
		.map_or_else(|| "$0.00".to_string(), |u| format!("${:.4}", u as f64 / 1_000_000.0));
	container = container.child(setting_row(
		"Session Cost Total",
		Some("Accumulated monetary expenditure for active session"),
		Badge::new(cost_str, TintRole::Done),
		&av,
		geometry,
		tokens,
	));

	// The token counts are one table: a metric per row, the count beside it
	// in tabular figures, so the columns of digits line up for comparison.
	let metrics: Vec<(&'static str, String)> = vec![
		("Input", format_number(totals.input_tokens)),
		("Output", format_number(totals.output_tokens)),
		("Cache read", format_number(totals.cache_read_tokens)),
		("Cache write", format_number(totals.cache_write_tokens)),
		("Orchestration", format_number(totals.orchestration_tokens)),
		("Premium requests", format_number(totals.premium_requests as u64)),
	];
	let row_count = metrics.len();
	let table = Table::new(
		[TableColumn::new("Metric"), TableColumn::new("Count")],
		row_count,
		move |row, col, _window, app| {
			let default_tokens = TokenSet::default();
			let tokens = app.try_global::<TokenSet>().unwrap_or(&default_tokens);
			let Some((metric, count)) = metrics.get(row) else {
				return div().into_any_element();
			};
			match col {
				0 => div()
					.text_color(tokens.color(ColorRole::Foreground))
					.child(*metric)
					.into_any_element(),
				_ => div()
					.w_full()
					.text_align(TextAlign::Right)
					.font_family(tokens.mono_family())
					.text_color(tokens.color(ColorRole::Secondary))
					.child(count.clone())
					.into_any_element(),
			}
		},
	);
	container = container.child(
		div()
			.w_full()
			.rounded(tokens.radius(RadiusStep::Sm))
			.overflow_hidden()
			.child(table),
	);

	container
}
