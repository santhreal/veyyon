//! The right panel's tab strip (§5.6).

use veyyon_desktop_kit::{
	ColorRole, Dot, Icon, IconName, IconSize, RadiusStep, SpacingStep, TextRamp, TextWeight,
	TintRole, TokenSet,
};
use veyyon_desktop_model::SessionId;
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, CursorStyle, Div, InteractiveElement, ParentElement, SharedString,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	ShellView,
	controls::{Availability, ControlStates},
	intent::Intent,
	right_panel::{PanelContent, PanelTab},
};

/// Builds the right panel tab strip with stats and navigation intents.
pub fn tab_strip(
	panel: &PanelContent,
	controls: &ControlStates,
	session_id: u64,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut strip = div()
		.h(px(geometry.tabs_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(px(geometry.tabs_gap_px))
		.px(tokens.spacing(SpacingStep::S2))
		.border_b(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.overflow_hidden();

	for (index, &tab) in panel.tabs.iter().enumerate() {
		let selected = tab == panel.active_tab;
		let ink = if selected {
			ColorRole::Foreground
		} else {
			ColorRole::Muted
		};
		let weight = if selected {
			TextWeight::Medium
		} else {
			TextWeight::Regular
		};

		let hover = tokens.row_hover();
		let ground = if selected {
			tokens.row_selected()
		} else {
			tokens.transparent()
		};

		let group_name = SharedString::from(format!("panel-tab-{index}"));
		let mut tab_el = div()
			.id(("panel-tab", index))
			.group(group_name.clone())
			.on_click(cx.listener(move |view, _event, _window, cx| {
				view.dispatch(Intent::SelectTab(tab), cx);
			}))
			.hover(move |style| style.bg(hover))
			.h(px(geometry.tabs_height_px))
			.px(tokens.spacing(SpacingStep::S2))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(ground)
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S1))
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(tokens.line_height(TextRamp::Micro))
			.font_weight(tokens.font_weight(weight))
			.text_color(tokens.color(ink))
			.child(tab.label());

		if tab == PanelTab::Diff {
			let additions = panel.total_additions();
			let deletions = panel.total_deletions();
			if additions > 0 || deletions > 0 {
				tab_el = tab_el
					.child(
						div()
							.flex_shrink_0()
							.text_color(tokens.tint(TintRole::Done).ink)
							.child(format!("+{additions}")),
					)
					.child(
						div()
							.flex_shrink_0()
							.text_color(tokens.tint(TintRole::Error).ink)
							.child(format!("-{deletions}")),
					);
			}
		}

		// The mark is the host's request, not the tab's own state: a tab the
		// projection does not own has nothing in flight and draws none.
		let tab_sid = tab.surface_id(SessionId::from(session_id.to_string()));
		if controls.projected_availability(&tab_sid) == Some(&Availability::Pending) {
			tab_el =
				tab_el.child(Dot::role(ColorRole::WorkingFill).sized(px(geometry.tabs_pending_dot_px)));
		}

		// Closing a tab is the window's own business, so the close carries no
		// gate: it is drawn while there is a tab left to fall back to, and it
		// answers whenever it is drawn. The reveal rides on the control
		// itself rather than on a wrapper, because a wrapper carrying a
		// group-hover style is hit-tested too and the strip would answer two
		// rects for one close.
		if panel.tabs.len() > 1 {
			tab_el = tab_el.child(
				div()
					.id(("panel-tab-close", index))
					.w(px(geometry.tabs_close_hit_px))
					.h(px(geometry.tabs_close_hit_px))
					.flex_shrink_0()
					.flex()
					.items_center()
					.justify_center()
					.rounded(tokens.radius(RadiusStep::Sm))
					.cursor(CursorStyle::PointingHand)
					.invisible()
					.group_hover(group_name, |style| style.visible())
					.hover(|style| style.bg(tokens.row_hover()))
					.child(
						Icon::new(IconName::Close)
							.size(IconSize::Size12)
							.color(tokens.color(ColorRole::Muted)),
					)
					.on_click(cx.listener(move |view, _event, _window, cx| {
						cx.stop_propagation();
						view.dispatch(Intent::CloseTab(tab), cx);
					})),
			);
		}

		strip = strip.child(tab_el);
	}

	strip
}
