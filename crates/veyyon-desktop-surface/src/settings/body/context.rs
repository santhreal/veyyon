//! `ContextBreakdown` settings page body rendering (§5.9).

use veyyon_desktop_kit::{Badge, ColorRole, RadiusStep, TintRole, TokenSet};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div, px};

use crate::{
	ShellView,
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

/// Renders the Context window allocation breakdown page rows.
pub fn render_context_page(
	state: &SettingsState,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.gap(veyyon_gpui::px(geometry.row_gap));

	let Some(ctx) = &state.context else {
		return container.child(empty_state_row(
			"No context window breakdown available.",
			geometry,
			tokens,
		));
	};

	let shell_state = cx.entity().read(cx).state();
	let av = shell_state
		.controls
		.availability(&SurfaceId::ContextBreakdownRefreshButton);

	// Header row: Total allocation
	let total_label = if let Some(limit) = ctx.limit_tokens {
		let pct = if limit > 0 {
			(ctx.total_tokens as f64 / limit as f64) * 100.0
		} else {
			0.0
		};
		format!("{} / {} tokens ({:.1}%)", format_number(ctx.total_tokens), format_number(limit), pct)
	} else {
		format!("{} tokens", format_number(ctx.total_tokens))
	};

	container = container.child(setting_row(
		"Context Allocation",
		Some("Active session context window token utilization"),
		Badge::new(total_label, TintRole::Plan),
		&av,
		geometry,
		tokens,
	));

	// Meter bar if limit is known
	if let Some(limit) = ctx.limit_tokens
		&& limit > 0 {
			let ratio = ((ctx.total_tokens as f32 / limit as f32) * 100.0).clamp(0.0, 100.0);
			let meter = div()
				.w_full()
				.h(px(4.0))
				.rounded(tokens.radius(RadiusStep::Full))
				.bg(tokens.color(ColorRole::Inset))
				.overflow_hidden()
				.child(
					div()
						.h_full()
						.w(veyyon_gpui::relative(ratio / 100.0))
						.bg(tokens.color(ColorRole::Accent)),
				);
			container = container.child(meter);
		}

	// Categories
	for cat in &ctx.categories {
		let share = if ctx.total_tokens > 0 {
			format!("{:.1}%", (cat.tokens as f64 / ctx.total_tokens as f64) * 100.0)
		} else {
			"0.0%".to_string()
		};

		let desc = format!("Category token share: {share}");
		let chip = Badge::new(format!("{} tokens", format_number(cat.tokens)), TintRole::Plan);

		container = container.child(setting_row(&cat.name, Some(&desc), chip, &av, geometry, tokens));
	}

	container
}
