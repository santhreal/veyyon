//! The field's state: how one is built, what it holds, and the small moves
//! every action is written in terms of.
//!
//! Every file in this directory adds one `impl Editor` block over the struct in
//! the parent module, and reaches the parent's imports through one glob. The
//! struct's fields stay private to the family.

use super::*;

impl Editor {
	pub fn new(
		placeholder: impl Into<SharedString>,
		multiline: bool,
		cx: &mut Context<Self>,
	) -> Self {
		let blink = cx.spawn(async move |this, cx| {
			loop {
				cx.background_executor().timer(BLINK).await;
				let alive = this
					.update(cx, |editor, cx| {
						if editor.focused {
							editor.caret_on = !editor.caret_on;
							cx.notify();
						}
					})
					.is_ok();
				if !alive {
					break;
				}
			}
		});

		Editor {
			focus: cx.focus_handle(),
			text: SharedString::default(),
			selection: 0..0,
			reversed: false,
			marked: None,
			placeholder: placeholder.into(),
			multiline,
			context: if multiline {
				"MultilineEditor"
			} else {
				"Editor"
			},
			min_height: px(20.0),
			max_height: px(240.0),
			shaped: None,
			dragging: false,
			focused: false,
			caret_on: true,
			scroll: px(0.0),
			_blink: blink,
		}
	}

	/// How tall the field is when empty and how tall it may grow.
	pub fn heights(mut self, min: f32, max: f32) -> Self {
		self.min_height = px(min);
		self.max_height = px(max);
		self
	}

	/// Dispatch in a named keymap context instead of the default.
	pub fn context(mut self, context: &'static str) -> Self {
		self.context = context;
		self
	}

	pub fn text(&self) -> &str {
		&self.text
	}

	/// The caret, as a byte offset.
	pub fn caret(&self) -> usize {
		if self.reversed {
			self.selection.start
		} else {
			self.selection.end
		}
	}

	/// Replace the whole text and put the caret at `caret`, clamped.
	///
	/// Setting the text it already holds does nothing, so a render that pushes
	/// the model's value every frame does not fight the caret.
	pub fn set_text(&mut self, text: &str, caret: usize, cx: &mut Context<Self>) {
		if self.text == text {
			return;
		}
		self.text = SharedString::from(text.to_owned());
		let caret = text::clamp(&self.text, caret);
		self.selection = caret..caret;
		self.reversed = false;
		self.marked = None;
		self.scroll = px(0.0);
		cx.notify();
	}

	pub fn clear(&mut self, cx: &mut Context<Self>) {
		self.text = SharedString::default();
		self.selection = 0..0;
		self.reversed = false;
		self.marked = None;
		self.scroll = px(0.0);
		cx.notify();
	}

	/// Put the keyboard in a field.
	///
	/// Associated rather than a method: `field.read(cx)` borrows the app, and
	/// focusing needs it mutably, so every caller would have to name the handle
	/// itself to get out of the borrow.
	pub fn focus(field: &Entity<Editor>, window: &mut Window, cx: &mut App) {
		let handle = field.read(cx).focus.clone();
		window.focus(&handle, cx);
	}

	/// Whether this field holds the keyboard.
	pub fn holds_keyboard(field: &Entity<Editor>, window: &Window, cx: &App) -> bool {
		field.read(cx).focus.is_focused(window)
	}

	pub(super) fn shape_input(&self) -> ShapeInput {
		let placeholder = self.text.is_empty();
		ShapeInput {
			display: if placeholder {
				self.placeholder.clone()
			} else {
				self.text.clone()
			},
			marked: self.marked.clone(),
			placeholder,
		}
	}

	pub(super) fn edited(&mut self, cx: &mut Context<Self>) {
		self.caret_on = true;
		cx.emit(EditorEvent::Changed);
		cx.notify();
	}

	pub(super) fn moved(&mut self, cx: &mut Context<Self>) {
		self.caret_on = true;
		cx.notify();
	}

	pub(super) fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
		let offset = text::clamp(&self.text, offset);
		self.selection = offset..offset;
		self.reversed = false;
		self.moved(cx);
	}

	pub(super) fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
		let offset = text::clamp(&self.text, offset);
		if self.reversed {
			self.selection.start = offset;
		} else {
			self.selection.end = offset;
		}
		if self.selection.end < self.selection.start {
			self.reversed = !self.reversed;
			self.selection = self.selection.end..self.selection.start;
		}
		self.moved(cx);
	}

	pub(super) fn replace(&mut self, range: Range<usize>, with: &str, cx: &mut Context<Self>) {
		let (text, caret) = text::replace(&self.text, range, with);
		self.text = SharedString::from(text);
		self.selection = caret..caret;
		self.reversed = false;
		self.marked = None;
		self.edited(cx);
	}

	pub(super) fn selected_range(&self) -> Range<usize> {
		if self.selection.is_empty() {
			self.caret()..self.caret()
		} else {
			self.selection.clone()
		}
	}
}
