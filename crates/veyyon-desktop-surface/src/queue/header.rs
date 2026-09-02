//! Queue rail section header and overflow row renderers (§5.1, §5.2).
//!
//! Renders section headers with collapse chevrons and the overflow indicator
//! row.

use veyyon_desktop_kit::{
	ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{IconButton, IconButtonVariant},
	icons::{IconName, IconSize},
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::{ShellView, model::Section};

/// Renders a section header: section label, row count, and optional collapse
/// toggle.
pub fn section_header(
	section: Section,
	count: usize,
	collapsed: bool,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let is_collapsible = matches!(section, Section::Deferred | Section::Parked);
	let mut header = div()
		.id(ElementId::NamedInteger("queue-section-header".into(), section as u64))
		.flex_shrink_0()
		.h(px(geometry.section_header_px))
		.mt(px(geometry.section_gap_above))
		.mb(px(geometry.section_gap_below))
		.px(px(geometry.content_inset))
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));

	if is_collapsible {
		let chevron_icon = if collapsed {
			IconName::ChevronRight
		} else {
			IconName::ChevronDown
		};
		header = header
			.cursor_pointer()
			.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
				view
					.rail_motion_mut()
					.toggle_collapsed(section, std::time::Instant::now());
				cx.notify();
			}))
			.child(
				IconButton::new(chevron_icon)
					.id(ElementId::NamedInteger("queue-section-toggle".into(), section as u64))
					.size(IconSize::Size12)
					.variant(IconButtonVariant::Ghost),
			);
	}

	header
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Muted))
				.child(section.label().to_owned()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Placeholder))
				.child(count.to_string()),
		)
}

/// Renders the row that indicates additional rows not shown due to height
/// limits.
#[must_use]
pub fn more_row(hidden: usize, geometry: &QueueSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.flex_shrink_0()
		.h(px(geometry.line_px))
		.mx(px(geometry.row_inset))
		.px(px(geometry.card_padding_horizontal))
		.flex()
		.items_center()
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Muted))
		.child(format!("{hidden} more"))
}
