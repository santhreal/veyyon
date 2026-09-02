//! The composer, the run bar and the opening line (§5.4).
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

pub mod actions;
pub mod attachments;
pub mod footer;
pub mod media;
pub mod state;
pub mod turn;

use veyyon_desktop_kit::{
	Badge as BadgeChip, ColorRole, Icon, IconName, IconSize, SpacingStep, TokenSet, input::Editor,
};
use veyyon_desktop_tokens::ComposerSurfaceTokens;
use veyyon_gpui::{
	BoxShadow, Context, DragMoveEvent, Entity, ExternalPaths, InteractiveElement, IntoElement,
	ParentElement, Styled, div, point, px,
};

pub use self::{actions::*, attachments::*, footer::*, media::*, state::*, turn::*};
use crate::{ShellView, controls::ControlStates, model::Badge};

/// What the composer draws that is the window's and not the state's: whether
/// files are being dragged over it, which turns the float into a drop target,
/// and why the last attachment was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ComposerLocal<'a> {
	/// Files from outside the window are over the composer's float.
	pub dropping: bool,
	/// The refusal the tray shows under the cards, until the next attachment.
	pub notice:   Option<&'a str>,
}

/// Builds the composer.
pub fn composer(
	editor: Option<&Entity<Editor>>,
	turn: &TurnPhase,
	composer: &ComposerState,
	local: ComposerLocal<'_>,
	has_text: bool,
	session_id: u64,
	width: f32,
	labels: bool,
	controls: &ControlStates,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut ground = tokens.color(ColorRole::Float);
	ground.a = geometry.ground_opacity;

	let mut shadow_colour = tokens.color(ColorRole::Ground);
	shadow_colour.a = geometry.shadow_opacity;

	let editor_content = if let Some(ed) = editor {
		div()
			.id("composer-editor-wrap")
			.w_full()
			.flex_1()
			.overflow_hidden()
			.child(ed.clone())
	} else {
		let (text, ink) = if has_text {
			("", ColorRole::Foreground)
		} else {
			("Ask, or describe a change", ColorRole::Placeholder)
		};
		div()
			.id("composer-editor-wrap")
			.w_full()
			.flex_1()
			.overflow_hidden()
			.text_color(tokens.color(ink))
			.child(text.to_owned())
	};

	// The float is a drop target for files from outside the window: the edge
	// takes the accent while they are over it, the target layer names what
	// may be dropped, and a drop attaches what the operator let go of.
	let accent = tokens.color(ColorRole::Accent);
	div()
		.id("composer-root")
		.flex()
		.flex_row()
		.justify_center()
		.w_full()
		.child(
			div()
				.id("composer-float")
				.relative()
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
				.gap(tokens.spacing(SpacingStep::S2))
				.overflow_hidden()
				.drag_over::<ExternalPaths>(move |style, _paths, _window, _cx| {
					style.border_color(accent)
				})
				.on_drag_move(cx.listener(|view, event: &DragMoveEvent<ExternalPaths>, _window, cx| {
					let over = event.bounds.contains(&event.event.position);
					if view.set_dropping(over) {
						cx.notify();
					}
				}))
				.on_drop(cx.listener(|view, paths: &ExternalPaths, _window, cx| {
					view.set_dropping(false);
					view.attach_paths(paths.paths().to_vec(), cx);
				}))
				.child(editor_content)
				.children(
					(!composer.attachments.is_empty())
						.then(|| attachment_tray(composer, turn, geometry, tokens, cx)),
				)
				.children(
					local
						.notice
						.map(|notice| attachment_notice(notice, tokens, cx)),
				)
				.child(footer_row(
					turn, composer, has_text, session_id, labels, controls, geometry, tokens, cx,
				))
				.children(local.dropping.then(|| drop_target(geometry, tokens))),
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
		.id("run-bar")
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
			.id("composer-opening-line")
			.max_w(px(geometry.opening_line_max_width_px))
			.text_size(px(geometry.opening_line_type_size.size))
			.line_height(px(geometry.opening_line_type_size.line_height))
			.font_weight(veyyon_gpui::FontWeight(f32::from(geometry.opening_line_weight)))
			.text_color(tokens.color(ColorRole::Secondary))
			.child(text.to_owned()),
	)
}
