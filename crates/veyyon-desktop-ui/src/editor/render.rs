//! The editor's element tree: key context, focus, actions and pointer input
//! around the text element.

use veyyon_gpui::{Context, CursorStyle, IntoElement, MouseButton, Render, Window, div, prelude::*};

use super::{
	Editor, EditorEvent, Motion, Unit,
	actions::{
		Backspace, Copy, Cut, Delete, DeleteToLineEnd, DeleteToLineStart, DeleteWordBackward,
		DeleteWordForward, Enter, Escape, KEY_CONTEXT, MoveDocEnd, MoveDocStart, MoveDown, MoveLeft,
		MoveLineEnd, MoveLineStart, MoveRight, MoveUp, MoveWordLeft, MoveWordRight, Newline, Paste,
		Redo, SelectAll, SelectDocEnd, SelectDocStart, SelectDown, SelectLeft, SelectLineEnd,
		SelectLineStart, SelectRight, SelectUp, SelectWordLeft, SelectWordRight, Undo,
	},
	element::EditorElement,
};
use crate::theme::{ActiveTheme, TypeStyled};

/// Registers one listener per `Action => handler` pair on `$element`.
macro_rules! on_actions {
	($element:expr, $cx:expr, { $($action:ty => $handler:expr),* $(,)? }) => {
		$element$(.on_action($cx.listener(|editor: &mut Editor, _: &$action, _, cx| {
			let handler: fn(&mut Editor, &mut Context<Editor>) = $handler;
			handler(editor, cx);
		})))*
	};
}

impl Render for Editor {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let element = div()
			.key_context(KEY_CONTEXT)
			.track_focus(&self.focus_handle)
			.cursor(CursorStyle::IBeam)
			.w_full()
			.overflow_hidden()
			.type_style(self.text_style)
			.text_color(cx.theme().palette.text.primary);
		on_actions!(element, cx, {
			MoveLeft => |e, cx| e.motion(Motion::Left, false, cx),
			MoveRight => |e, cx| e.motion(Motion::Right, false, cx),
			SelectLeft => |e, cx| e.motion(Motion::Left, true, cx),
			SelectRight => |e, cx| e.motion(Motion::Right, true, cx),
			MoveUp => |e, cx| e.vertical(false, false, cx),
			MoveDown => |e, cx| e.vertical(true, false, cx),
			SelectUp => |e, cx| e.vertical(false, true, cx),
			SelectDown => |e, cx| e.vertical(true, true, cx),
			MoveWordLeft => |e, cx| e.motion(Motion::WordLeft, false, cx),
			MoveWordRight => |e, cx| e.motion(Motion::WordRight, false, cx),
			SelectWordLeft => |e, cx| e.motion(Motion::WordLeft, true, cx),
			SelectWordRight => |e, cx| e.motion(Motion::WordRight, true, cx),
			MoveLineStart => |e, cx| e.motion(Motion::LineStart, false, cx),
			MoveLineEnd => |e, cx| e.motion(Motion::LineEnd, false, cx),
			SelectLineStart => |e, cx| e.motion(Motion::LineStart, true, cx),
			SelectLineEnd => |e, cx| e.motion(Motion::LineEnd, true, cx),
			MoveDocStart => |e, cx| e.motion(Motion::DocStart, false, cx),
			MoveDocEnd => |e, cx| e.motion(Motion::DocEnd, false, cx),
			SelectDocStart => |e, cx| e.motion(Motion::DocStart, true, cx),
			SelectDocEnd => |e, cx| e.motion(Motion::DocEnd, true, cx),
			SelectAll => |e, cx| e.select_all(cx),
			Backspace => |e, cx| e.delete(true, Unit::Grapheme, cx),
			Delete => |e, cx| e.delete(false, Unit::Grapheme, cx),
			DeleteWordBackward => |e, cx| e.delete(true, Unit::Word, cx),
			DeleteWordForward => |e, cx| e.delete(false, Unit::Word, cx),
			DeleteToLineStart => |e, cx| e.delete(true, Unit::Line, cx),
			DeleteToLineEnd => |e, cx| e.delete(false, Unit::Line, cx),
			Undo => |e, cx| e.undo(cx),
			Redo => |e, cx| e.redo(cx),
			Copy => |e, cx| e.copy(cx),
			Cut => |e, cx| e.cut(cx),
			Paste => |e, cx| e.paste(cx),
			Enter => |e, cx| e.enter(false, cx),
			Newline => |e, cx| e.enter(true, cx),
			Escape => |_, cx| cx.emit(EditorEvent::Escape),
		})
		.on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
		.on_scroll_wheel(cx.listener(Self::scroll_wheel))
		.child(EditorElement { editor: cx.entity() })
	}
}
