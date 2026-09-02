//! Drawer header chrome and tab strip.
//!
//! Renders the 28px chrome row containing tenant tabs (terminals and process
//! supervisor), active title, palette search match count, and the vertical
//! resize drag affordance.

use veyyon_desktop_kit::{
	ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{Button, ButtonVariant},
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use super::content::{DrawerContent, DrawerTab};
use crate::{Intent, ShellView};

/// Builds the drawer chrome header bar.
pub fn drawer_chrome(
	content: &DrawerContent,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut tabs_strip = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(px(geometry.tabs_gap_px));

	if content.tabs.is_empty() {
		tabs_strip = tabs_strip.child(
			div()
				.h(px(geometry.tabs_height_px))
				.px(tokens.spacing(SpacingStep::S2))
				.flex()
				.items_center()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Secondary))
				.child("Terminal"),
		);
	} else {
		for (idx, tab) in content.tabs.iter().enumerate() {
			let is_active = idx == content.active_tab;
			let label = match tab {
				DrawerTab::Terminal { title, id } => {
					if title.is_empty() {
						format!("Terminal {id}")
					} else {
						title.clone()
					}
				},
				DrawerTab::Processes => "Processes".to_string(),
			};

			let mut tab_el = div()
				.h(px(geometry.tabs_height_px))
				.max_w(px(geometry.tabs_max_width_px))
				.px(tokens.spacing(SpacingStep::S2))
				.flex()
				.flex_row()
				.items_center()
				.cursor_pointer()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(if is_active {
					tokens.font_weight(TextWeight::Semibold)
				} else {
					tokens.font_weight(TextWeight::Medium)
				})
				.text_color(if is_active {
					tokens.color(ColorRole::Foreground)
				} else {
					tokens.color(ColorRole::Secondary)
				})
				.id(("drawer-tab", idx))
				.on_click(cx.listener(move |view, _event: &ClickEvent, _window, _cx| {
					view.dispatch(Intent::SelectDrawerTab(idx));
				}))
				.child(label);

			if is_active {
				tab_el = tab_el
					.bg(tokens.color(ColorRole::Canvas))
					.border_b(px(2.0))
					.border_color(tokens.color(ColorRole::Accent));
			}

			tabs_strip = tabs_strip.child(tab_el);
		}
	}

	let mut right_side = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));

	if let Some(search) = &content.search {
		right_side = right_side.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{} matches", search.match_count)),
		);
	}

	if !content.is_processes_active() {
		right_side = right_side
			.child(
				Button::new("Clear")
					.id("clear-terminal-btn")
					.variant(ButtonVariant::Ghost)
					.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
						view.dispatch(Intent::ClearTerminal);
					})),
			)
			.child(
				Button::new("Restart")
					.id("restart-terminal-btn")
					.variant(ButtonVariant::Ghost)
					.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
						view.dispatch(Intent::RestartTerminal);
					})),
			);
	}

	div()
		.h(px(geometry.chrome_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.px(tokens.spacing(SpacingStep::S3))
		.border_b(px(1.0))
		.border_color(tokens.color(ColorRole::Hairline))
		.child(tabs_strip)
		.child(
			div().flex_1().flex().justify_center().child(
				div()
					.h(px(geometry.chrome_resize_handle_line_px))
					.w(px(geometry.chrome_resize_handle_hit_px))
					.bg(tokens.color(ColorRole::Hairline)),
			),
		)
		.child(right_side)
}
