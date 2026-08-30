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
use veyyon_gui_core::{
	store::model::{Block, Message, Role},
	text::markdown::Md,
};
use veyyon_gui_kit::{
	theme::{Theme, layout, radius, space},
	ui::{Icon, Spinner, icon, square, text},
};

use super::{diff, markdown, tool};

/// How wide the operator's side of the column is.
///
/// Short of the reading width, so a turn of two words is a block and not a
/// line: the gap on the left is what makes the right edge read as a side.
const WRITTEN: f32 = layout::READING * 0.86;

/// One message.
pub fn turn(message: &Message, cx: &mut App) -> Div {
	match message.role {
		Role::Operator => written(message, cx),
		Role::Engine => answered(message, cx),
	}
}

/// What the operator wrote.
///
/// Prose sits in a bubble that hugs it. A fence, a patch or a tool call stands
/// outside the bubble at the side's own width, because a fill around a card is
/// two fills around one thing, and a bubble stretched to a card's width is the
/// shape an engine's answer has.
fn written(message: &Message, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut column = text::stack(space::BASE).items_end().w_full();
	let mut prose: Vec<AnyElement> = Vec::new();

	for piece in pieces(message, cx) {
		match piece {
			Piece::Prose(element) => prose.push(element),
			Piece::Alone(element) => {
				column = column
					.children(bubble(&mut prose, &theme))
					.child(div().w(px(WRITTEN)).child(element));
			},
		}
	}
	column.children(bubble(&mut prose, &theme))
}

/// The fill around a run of prose, and nothing at all around no prose.
fn bubble(prose: &mut Vec<AnyElement>, theme: &Theme) -> Option<Div> {
	if prose.is_empty() {
		return None;
	}
	Some(
		text::stack(space::BASE)
			.max_w(px(WRITTEN))
			.px(px(space::WIDE))
			.py(px(space::BASE))
			.rounded(px(radius::CARD))
			.bg(theme.raised)
			.border_1()
			// A fill this close to the canvas disappears in the light palette,
			// where a bubble is a bubble because of its edge rather than its
			// ground.
			.border_color(theme.stroke)
			.text_color(theme.text)
			.children(prose.drain(..)),
	)
}

/// What an engine wrote. Nothing produces one yet.
fn answered(message: &Message, cx: &mut App) -> Div {
	let theme = Theme::get(cx);

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
				.children(blocks(message, cx))
				.children(message.streaming.then(|| {
					// While it is still writing, the caret of the conversation:
					// one turning mark under the text, which stops when the
					// message does.
					Spinner::new(format!("writing-{}", message.id)).size(veyyon_gui_kit::ui::Size::Small)
				})),
		)
}

/// A drawn part of a message, and whether it can share a fill with its
/// neighbours.
enum Piece {
	/// Text. Several in a row belong in one bubble.
	Prose(AnyElement),
	/// Something with a width and an edge of its own.
	Alone(AnyElement),
}

/// Every drawn part of a message, in order, each with its own stable id.
fn pieces(message: &Message, cx: &mut App) -> Vec<Piece> {
	let mut pieces: Vec<Piece> = Vec::new();
	for (index, block) in message.blocks.iter().enumerate() {
		let id = format!("m{}-{index}", message.id);
		match block {
			Block::Prose(blocks) => {
				for (part, block) in blocks.iter().enumerate() {
					let element = markdown::block(block, &format!("{id}-{part}"), cx);
					pieces.push(match block {
						// A fence and a table have a width of their own and an
						// edge of their own. Inside a bubble they stretch it to
						// the full side, which is the shape an engine's answer
						// has, and put one fill inside another.
						Md::Code { .. } | Md::Table { .. } => Piece::Alone(element),
						_ => Piece::Prose(element),
					});
				}
			},
			Block::Patch(files) => pieces.extend(diff::patch(files, cx).into_iter().map(Piece::Alone)),
			Block::Tool(call) => pieces.push(Piece::Alone(tool::call(call, cx).into_any_element())),
		}
	}
	pieces
}

/// Every block of a message, in order, with nothing said about where it goes.
fn blocks(message: &Message, cx: &mut App) -> Vec<AnyElement> {
	pieces(message, cx)
		.into_iter()
		.map(|piece| match piece {
			Piece::Prose(element) | Piece::Alone(element) => element,
		})
		.collect()
}
