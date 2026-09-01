//! The composer, the run bar and the opening line (§5.3).
//!
//! The composer floats over the transcript rather than sitting below it, so the
//! text being written stays in the same place while the run scrolls underneath.
//! That is why its ground is a translucent float with its own shadow: the
//! elevation is what separates it from content that passes behind it, and
//! without it the two read as one column.
//!
//! The run bar is the one always-visible statement of what the session is
//! doing. It is deliberately a single short line: anything that needs more room
//! than that belongs in the transcript, where it can be read at leisure.

use veyyon_desktop_kit::{
	Badge as BadgeChip, ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, TextRamp,
	TextWeight, TokenSet,
};
use veyyon_desktop_tokens::ComposerSurfaceTokens;
use veyyon_gpui::{
	BoxShadow, Context, Div, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, point, px,
};

use crate::{ShellView, intent::Intent, model::Badge};

/// Builds the composer.
pub fn composer(
	composed: &str,
	width: f32,
	labels: bool,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	// The float's ground is translucent so the transcript passing behind it
	// stays perceptible, and the backdrop is blurred and saturated so that what
	// passes behind reads as texture rather than as competing text. Fork patch
	// P6 supplies the sampling; both values come from the composer's own
	// material tokens, so the glass is retuned in the token file.
	let mut ground = tokens.color(ColorRole::Float);
	ground.a = geometry.ground_opacity;

	let mut shadow_colour = tokens.color(ColorRole::Ground);
	shadow_colour.a = geometry.shadow_opacity;

	let (text, ink) = if composed.is_empty() {
		("Ask, or describe a change", ColorRole::Placeholder)
	} else {
		(composed, ColorRole::Foreground)
	};

	div().flex().flex_row().justify_center().w_full().child(
		div()
			.w(px(width))
			.min_h(px(geometry.rest_height_px))
			.max_h(px(geometry.growth_cap_px))
			.bg(ground)
			.backdrop_blur(px(geometry.blur_px))
			.backdrop_saturation(geometry.saturation)
			.rounded(px(geometry.radius_outer))
			.border(px(geometry.hairline_stroke))
			.border_color(tokens.color(ColorRole::Hairline))
			.shadow(vec![BoxShadow {
				color:         shadow_colour,
				offset:        point(px(geometry.shadow_x), px(geometry.shadow_y)),
				blur_radius:   px(geometry.shadow_blur),
				spread_radius: px(geometry.shadow_spread),
				inset:         false,
			}])
			.pt(px(geometry.padding_top))
			.pb(px(geometry.padding_bottom))
			.px(px(geometry.padding_horizontal))
			.flex()
			.flex_col()
			.justify_between()
			.overflow_hidden()
			.child(
				div()
					.w_full()
					.flex_1()
					.overflow_hidden()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.text_color(tokens.color(ink))
					.child(text.to_owned()),
			)
			.child(footer(composed, labels, geometry, tokens, cx)),
	)
}

/// The composer's footer: what the next send will use, and the send itself.
fn footer(
	composed: &str,
	labels: bool,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	// The footer states the settings that change what a send does, capped at
	// the token's control count so a narrow window sheds the least important
	// rather than wrapping to a second row. Below the label breakpoint each
	// control is its icon alone: the row keeps every control instead of
	// dropping the ones that no longer fit (§5.7).
	let controls = [
		(IconName::Settings, "claude-sonnet-4-6"),
		(IconName::Edit, "Plan mode"),
		(IconName::File, "3 files"),
	];

	let mut row = div()
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S3))
		.overflow_hidden();

	for (icon, control) in controls.iter().take(geometry.footer_max_controls) {
		row = row.child(if labels {
			div()
				.flex_shrink_0()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child((*control).to_owned())
		} else {
			div().flex_shrink_0().child(
				Icon::new(*icon)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::Muted)),
			)
		});
	}

	// An empty composer has nothing to send, and a send control that looks
	// live while doing nothing is the interaction an operator reads as broken.
	// So the control states whether there is anything to send: accent when
	// there is, quiet when there is not.
	let sendable = !composed.trim().is_empty();
	let (ground, ink) = if sendable {
		(tokens.color(ColorRole::Accent), tokens.color(ColorRole::AccentForeground))
	} else {
		(tokens.color(ColorRole::Inset), tokens.color(ColorRole::Muted))
	};
	let text = composed.to_owned();

	row.child(div().flex_1()).child(
		div()
			.id("composer-send")
			.on_click(cx.listener(move |view, _event, _window, cx| {
				view.dispatch(Intent::Send(text.clone()));
				cx.notify();
			}))
			.flex_shrink_0()
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S1))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(ground)
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(tokens.line_height(TextRamp::Micro))
			.font_weight(tokens.font_weight(TextWeight::Medium))
			.text_color(ink)
			.child("Send"),
	)
}

/// Builds the run bar: one line stating what the session is doing.
pub fn run_bar(
	status: Option<(Badge, String)>,
	width: f32,
	labels: bool,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
) -> impl IntoElement {
	let mut bar = div()
		.h(px(geometry.run_bar_height_px))
		.w(px(width))
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.overflow_hidden();

	if let Some((badge, line)) = status {
		bar = bar
			.child(
				div()
					.flex_shrink_0()
					.child(BadgeChip::new(badge.label(), badge.tint())),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(px(geometry.run_bar_label_size.size))
					.line_height(px(geometry.run_bar_label_size.line_height))
					.text_color(tokens.color(ColorRole::Secondary))
					.child(line),
			)
			.child(if labels {
				div()
					.flex_shrink_0()
					.text_size(px(geometry.run_bar_label_size.size))
					.line_height(px(geometry.run_bar_label_size.line_height))
					.text_color(tokens.color(ColorRole::Muted))
					.child("Stop")
			} else {
				div().flex_shrink_0().child(
					Icon::new(IconName::Stop)
						.size(IconSize::Size12)
						.color(tokens.color(ColorRole::Muted)),
				)
			});
	}

	div().flex().flex_row().justify_center().w_full().child(bar)
}

/// The opening line, shown on a session with no turns yet.
pub fn opening_line(
	text: &str,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
) -> impl IntoElement {
	div().flex().flex_row().justify_center().w_full().child(
		div()
			.max_w(px(geometry.opening_line_max_width_px))
			.text_size(px(geometry.opening_line_type_size.size))
			.line_height(px(geometry.opening_line_type_size.line_height))
			.font_weight(veyyon_gpui::FontWeight(f32::from(geometry.opening_line_weight)))
			.text_color(tokens.color(ColorRole::Secondary))
			.child(text.to_owned()),
	)
}
