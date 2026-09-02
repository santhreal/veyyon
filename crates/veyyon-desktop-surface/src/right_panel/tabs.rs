//! The right panel's tab strip (§5.6).

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	ShellView,
	intent::Intent,
	right_panel::{PanelContent, PanelTab},
};

/// Builds the right panel tab strip with stats and navigation intents.
pub fn tab_strip(
	panel: &PanelContent,
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

		let mut tab_el = div()
			.id(("panel-tab", index))
			.on_click(cx.listener(move |view, _event, _window, cx| {
				view.dispatch(Intent::SelectTab(index));
				cx.notify();
			}))
			.hover(move |style| style.bg(hover))
			.max_w(px(geometry.tabs_max_width_px))
			.min_w_0()
			.px(tokens.spacing(SpacingStep::S2))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(ground)
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S1))
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
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
							.text_color(tokens.tint(TintRole::Done).fill)
							.child(format!("+{additions}")),
					)
					.child(
						div()
							.flex_shrink_0()
							.text_color(tokens.tint(TintRole::Error).fill)
							.child(format!("-{deletions}")),
					);
			}
		}

		strip = strip.child(tab_el);
	}

	strip
}
