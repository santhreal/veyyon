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
		Editor {
			focus: cx.focus_handle(),
			text: String::new(),
			display: SharedString::default(),
			secret: false,
			selection: 0..0,
			reversed: false,
			marked: None,
			placeholder: placeholder.into(),
			multiline,
			kind: if multiline {
				"MultilineEditor"
			} else {
				"Editor"
			},
			name: None,
			min_height: px(crate::theme::layout::editor_single_line()),
			max_height: px(crate::theme::layout::composer_max_height()),
			shaped: None,
			dragging: false,
			focused: false,
			scroll: px(0.0),
		}
	}

	/// A field whose text is a secret: drawn masked, never copied or cut, and
	/// taken out through [`SecureEditor::take`] into a zeroizing value.
	///
	/// A constructor on `Editor` rather than on `SecureEditor`, because a secret
	/// field is one of these with two flags set, not a second kind of field.
	pub fn secure(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
		let mut editor = Self::new(placeholder, false, cx);
		editor.secret = true;
		editor.kind = "SecureEditor";
		editor
	}

	/// How tall the field is when empty and how tall it may grow.
	pub fn heights(mut self, min: f32, max: f32) -> Self {
		self.min_height = px(min);
		self.max_height = px(max);
		self
	}

	/// Answer to one more name than the field's kind, for a binding that
	/// belongs to the surface under this field.
	///
	/// The kind stays: a field that dropped it would lose every caret motion,
	/// since those are written over the kinds and not over the names.
	pub fn named(mut self, name: &'static str) -> Self {
		self.name = Some(name);
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
		self.set_storage(text.to_owned());
		let caret = text::clamp(&self.text, caret);
		self.selection = caret..caret;
		self.reversed = false;
		self.marked = None;
		self.scroll = px(0.0);
		cx.notify();
	}

	pub fn clear(&mut self, cx: &mut Context<Self>) {
		self.set_storage(String::new());
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
				self.display.clone()
			},
			marked: self.marked.clone(),
			placeholder,
		}
	}

	pub(super) fn edited(&mut self, cx: &mut Context<Self>) {
		cx.emit(EditorEvent::Changed);
		cx.notify();
	}

	pub(super) fn moved(&mut self, cx: &mut Context<Self>) {
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
		let (value, caret) = text::replace(&self.text, range, with);
		self.set_storage(value);
		self.selection = caret..caret;
		self.reversed = false;
		self.marked = None;
		self.edited(cx);
	}

	pub(super) fn set_storage(&mut self, value: String) {
		if self.secret {
			wipe_string(&mut self.text);
			self.display = "*".repeat(value.len()).into();
		} else {
			self.display = value.clone().into();
		}
		self.text = value;
	}

	pub(super) fn selected_range(&self) -> Range<usize> {
		if self.selection.is_empty() {
			self.caret()..self.caret()
		} else {
			self.selection.clone()
		}
	}
}

impl SecureEditor {
	/// Move the secret into a zeroizing boundary value and clear the editor.
	pub fn take(editor: &mut Editor, cx: &mut Context<Editor>) -> SecretValue {
		let bytes = std::mem::take(&mut editor.text).into_bytes();
		editor.display = SharedString::default();
		editor.selection = 0..0;
		editor.marked = None;
		editor.scroll = px(0.0);
		cx.notify();
		SecretValue(bytes)
	}
}

impl Drop for Editor {
	fn drop(&mut self) {
		if self.secret {
			wipe_string(&mut self.text);
		}
	}
}

fn wipe_string(value: &mut String) {
	let mut bytes = std::mem::take(value).into_bytes();
	bytes.fill(0);
}
