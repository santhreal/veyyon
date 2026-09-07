//! Queue rail section header, navigation bar, and paging row renderers (§5.1,
//! §5.2).
//!
//! Renders navigation search/new-session controls, collapsible section headers,
//! and interactive paging controls for archival partitions.

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{ButtonSize, IconButton, IconButtonVariant, control_metrics},
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, WeakEntity, div, px,
};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
	model::Section,
};

/// Renders the top navigation header containing search and new-session actions.
pub fn queue_nav_header(
	filter_query: Option<&str>,
	controls: &ControlStates,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let hover_bg = tokens.row_hover();
	let search_content = if let Some(q) = filter_query.filter(|s| !s.trim().is_empty()) {
		let current_q = q.to_string();
		div()
			.id("queue-search-active")
			.flex_1()
			.min_w_0()
			.h(px(28.0))
			.px(px(geometry.card_padding_horizontal))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(tokens.row_selected())
			.flex()
			.flex_row()
			.items_center()
			.justify_between()
			.gap(tokens.spacing(SpacingStep::S1))
			.child(
				div()
					.flex_1()
					.min_w_0()
					.flex()
					.flex_row()
					.items_center()
					.gap(tokens.spacing(SpacingStep::S1))
					.child(
						IconButton::new(IconName::Search)
							.id("queue-search-active-icon")
							.size(IconSize::Size12)
							.variant(IconButtonVariant::Ghost),
					)
					.child(
						div()
							.flex_1()
							.min_w_0()
							.overflow_hidden()
							.whitespace_nowrap()
							.truncate()
							.text_size(tokens.font_size(TextRamp::Small))
							.line_height(tokens.line_height(TextRamp::Small))
							.font_weight(tokens.font_weight(TextWeight::Medium))
							.text_color(tokens.color(ColorRole::Foreground))
							.child(current_q),
					),
			)
			.child(
				IconButton::new(IconName::Close)
					.id("queue-filter-clear")
					.size(IconSize::Size12)
					.variant(IconButtonVariant::Ghost)
					.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
						view.dispatch(Intent::FilterQueue(String::new()), cx);
					})),
			)
	} else {
		div()
			.id("queue-search-button")
			.cursor_pointer()
			.flex_1()
			.min_w_0()
			.h(px(28.0))
			.px(px(geometry.card_padding_horizontal))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(tokens.transparent())
			.hover(move |style| style.bg(hover_bg))
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.on_click(cx.listener(move |view, _event: &ClickEvent, window, cx| {
				view.open_queue_search(window, cx);
			}))
			.child(
				IconButton::new(IconName::Search)
					.id("queue-search-icon")
					.size(IconSize::Size12)
					.variant(IconButtonVariant::Ghost),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.font_weight(tokens.font_weight(TextWeight::Regular))
					.text_color(tokens.color(ColorRole::Muted))
					.child("Search sessions..."),
			)
	};
	let new_session_av = controls.availability(&SurfaceId::NewSessionButton);
	let (new_opacity, _, new_allowed) = availability_style(&new_session_av, tokens);
	let mut new_btn = IconButton::new(IconName::Edit)
		.id("queue-new-session")
		.size(IconSize::Size14)
		.variant(IconButtonVariant::Ghost);
	if new_allowed {
		new_btn = new_btn.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
			view.dispatch(Intent::NewSession, cx);
		}));
	} else {
		new_btn = new_btn.state(InteractiveState::Disabled);
	}
	let new_btn_el = div().opacity(new_opacity).child(new_btn);

	div()
		.id("queue-nav-header")
		.flex_shrink_0()
		.h(px(32.0))
		.mx(px(geometry.row_inset))
		.mb(px(geometry.section_gap_below))
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S1))
		.child(search_content)
		.child(new_btn_el)
}
/// Renders a section header: section label, row count, and optional collapse
/// toggle.
pub fn section_header(
	section: Section,
	count: usize,
	collapsed: bool,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	view: Option<WeakEntity<ShellView>>,
) -> impl IntoElement {
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

	let chevron_icon = if collapsed {
		IconName::ChevronRight
	} else {
		IconName::ChevronDown
	};
	let chevron_size = control_metrics(ButtonSize::Small, tokens).square;
	let chevron = div()
		.w(chevron_size)
		.h(chevron_size)
		.flex_shrink_0()
		.flex()
		.items_center()
		.justify_center()
		.child(Icon::new(chevron_icon).size(IconSize::Size12).color(tokens.color(ColorRole::Secondary)));

	if let Some(weak) = view {
		header = header
			.cursor_pointer()
			.on_click(move |_event, _window, app| {
				let _ = weak.update(app, |view, cx| {
					view
						.rail_motion_mut()
						.toggle_collapsed(section, std::time::Instant::now());
					cx.notify();
				});
			});
	}

	header = header.child(chevron);

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

/// Renders the static row indicating additional rows.
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

/// Renders the interactive row that pages in older archival rows.
pub fn older_row(
	hidden: usize,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	view: Option<WeakEntity<ShellView>>,
) -> impl IntoElement {
	let hover_bg = tokens.row_hover();
	let initial_page = geometry.parked_initial_page_size;

	let mut older = div()
		.id("queue-parked-older")
		.cursor_pointer()
		.flex_shrink_0()
		.h(px(geometry.line_px))
		.mx(px(geometry.row_inset))
		.px(px(geometry.card_padding_horizontal))
		.rounded(tokens.radius(RadiusStep::Sm))
		.bg(tokens.transparent())
		.hover(move |style| style.bg(hover_bg))
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S2));

	if let Some(weak) = view.clone() {
		older = older.on_click(move |_event, _window, app| {
			let _ = weak.update(app, |view, cx| {
				view.rail_motion_mut().show_more_parked(initial_page);
				cx.notify();
			});
		});
	}

	older.child(
		div()
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(
				IconButton::new(IconName::ChevronDown)
					.id("queue-older-chevron")
					.size(IconSize::Size12)
					.variant(IconButtonVariant::Ghost),
			)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Micro))
					.line_height(tokens.line_height(TextRamp::Micro))
					.font_weight(tokens.font_weight(TextWeight::Medium))
					.text_color(tokens.color(ColorRole::Muted))
					.child(format!("Older ({hidden} remaining)")),
			),
	)
}
