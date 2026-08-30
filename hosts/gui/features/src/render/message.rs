//! One turn.
//!
//! TWO SIDES, DRAWN DIFFERENTLY. What the operator wrote is a block against the
//! right edge: short, quoted back, and finished. What an engine writes is the
//! column itself, at full reading width, with no fill and no bubble, because it
//! is long, it is what the reader came for, and a fill around a screen of prose
//! is a box with no purpose. Every messaging application converges on this, and
//! the reason is the asymmetry of the content rather than fashion.
//!
//! A turn is its blocks, in order, drawn by the renderer for each. Nothing here
//! knows what a block is made of.

use gpui::{AnyElement, App, Div, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::store::model::{Block, Message, Role};
use veyyon_gui_kit::{
	theme::{Theme, layout, radius, size, space},
	ui::{Icon, Spinner, icon, square, text},
};

use super::{diff, markdown, tool};

/// One message.
pub fn turn(message: &Message, cx: &mut App) -> Div {
	match message.role {
		Role::Operator => written(message, cx),
		Role::Engine => answered(message, cx),
	}
}

/// What the operator wrote.
fn written(message: &Message, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let body = blocks(message, cx);

	// A block shrinks to its prose, except when it carries something with a
	// width of its own: a fence or a patch inside a bubble that hugs its text
	// ends up with the last glyph against the fill's edge, and a run of turns
	// steps in and out as their longest line changes.
	let wide = message
		.blocks
		.iter()
		.any(|block| !matches!(block, Block::Prose(_)))
		|| message.blocks.iter().any(has_code);

	let mut bubble = text::stack(space::BASE)
		.px(px(space::WIDE))
		.py(px(space::BASE))
		.rounded(px(radius::CARD))
		.bg(theme.raised)
		.text_color(theme.text)
		.children(body);
	bubble = if wide {
		bubble.w(px(layout::READING * 0.86))
	} else {
		bubble.max_w(px(layout::READING * 0.86))
	};

	div().flex().justify_end().w_full().child(bubble)
}

/// What an engine wrote. Nothing produces one yet.
fn answered(message: &Message, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let body = blocks(message, cx);

	div()
		.flex()
		.w_full()
		.gap(px(space::BASE))
		.child(
			// The mark stands in the margin, so a run of answers reads as one
			// column of prose with a gutter rather than as a stack of cards.
			square(icon::scale::BASE)
				.flex_none()
				.mt(px(2.0))
				.child(icon::base(Icon::Engine, theme.text_faint)),
		)
		.child(
			text::stack(space::BASE)
				.flex_1()
				.min_w(px(0.0))
				.text_color(theme.text)
				.children(body)
				.children(message.streaming.then(|| {
					// While it is still writing, the caret of the conversation:
					// one turning mark under the text, which stops when the
					// message does.
					Spinner::new(format!("writing-{}", message.id)).size(veyyon_gui_kit::ui::Size::Small)
				})),
		)
}

/// Every block of a message, in order.
fn blocks(message: &Message, cx: &mut App) -> Vec<AnyElement> {
	let mut elements: Vec<AnyElement> = Vec::new();
	for (index, block) in message.blocks.iter().enumerate() {
		let id = format!("m{}-{index}", message.id);
		match block {
			Block::Prose(blocks) => elements.extend(markdown::blocks(blocks, &id, cx)),
			Block::Patch(files) => elements.extend(diff::patch(files, cx)),
			Block::Tool(call) => elements.push(tool::call(call, cx).into_any_element()),
		}
	}
	elements
}

/// Whether a run of prose carries a fenced block.
fn has_code(block: &Block) -> bool {
	match block {
		Block::Prose(blocks) => blocks
			.iter()
			.any(|block| matches!(block, veyyon_gui_core::text::markdown::Md::Code { .. })),
		Block::Patch(_) | Block::Tool(_) => true,
	}
}

/// The size a message's text is drawn at, for a surface that has to match it.
pub const TEXT: f32 = size::BODY;
