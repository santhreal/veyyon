//! Branch and compaction summaries.

use gpui::{App, Div, ParentElement, Styled, px};
use veyyon_gui_core::text::markdown::Md;
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Icon, Tone, text},
};

use super::markdown;

pub fn summary(id: &str, kind: &str, blocks: &[Md], cx: &mut App) -> Div {
	let label = if kind.eq_ignore_ascii_case("branch") {
		"Branch summary"
	} else {
		"Compaction summary"
	};
	text::stack(space::TIGHT)
		.w_full()
		.min_w(px(0.0))
		.child(Badge::new(label).tone(Tone::Muted).icon(Icon::Changed))
		.child(
			text::stack(space::BASE)
				.w_full()
				.min_w(px(0.0))
				.children(markdown::blocks(blocks, id, cx)),
		)
}
