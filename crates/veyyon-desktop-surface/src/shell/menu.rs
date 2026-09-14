//! The window's menu bar: the words in the titlebar, and the section floated
//! under the pressed word.
//!
//! Linux gpui stores the menus a process sets and draws none of them, so the
//! bar is the window's own. An entry dispatches the gpui action its chord
//! dispatches, which is what keeps a menu item and a keystroke one code path
//! rather than two implementations of one verb.
//!
//! The open menu holds the window's focus, on the same terms as the detail
//! popover. That is what makes the arrows and Return reach the menu rather
//! than the region underneath: a bare `down` is bound to the queue's
//! selection and a bare `enter` to the composer's send, and a binding is
//! resolved before a raw keystroke listener runs, so a bar that left the
//! focus where it found it would move the queue's selection while its own
//! entries stood still. Closing gives the focus back to whatever held it.

use std::{cell::RefCell, rc::Rc};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{
	AnchorCorner, ColorRole, Menu, Popover, RadiusStep, SpacingStep, TextRamp, TokenSet,
};
use veyyon_gpui::{
	App, Context, FocusHandle, InteractiveElement, IntoElement, KeyDownEvent, MouseButton,
	ParentElement, Pixels, Point, Styled, Window, div, point, px,
};

use crate::{
	Intent, ShellView,
	keymap::{Command, build::build_action},
	menu::{MenuSectionId, MenuState},
};

mod picker;

/// Where the bar's words were laid out, one origin per section in bar order.
///
/// The open section is floated at the shell root rather than inside the bar,
/// because the titlebar clips what overflows it. The origin travels through a
/// handle for the reason the palette's does: a prepaint listener outlives the
/// render that installed it, and the next frame reads what it recorded.
pub(super) type MenuAnchors = Rc<RefCell<Vec<Point<Pixels>>>>;

impl ShellView {
	/// Where the bar's words were laid out, shared without a reentrant
	/// entity update.
	#[must_use]
	pub fn menu_anchors(&self) -> MenuAnchors {
		Rc::clone(&self.menu_anchors)
	}

	/// The focus the open menu holds, created on the first press that opens
	/// one.
	#[must_use]
	pub fn menu_focus(&mut self, cx: &mut Context<Self>) -> FocusHandle {
		self
			.menu_focus
			.get_or_insert_with(|| cx.focus_handle())
			.clone()
	}

	/// Opens the section under the pressed word, or closes it when it is the
	/// one already open, and moves the focus with it.
	pub fn toggle_menu_section(
		&mut self,
		section: Option<MenuSectionId>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if section.is_some() && self.palette_input.menu_focused {
			self.close_signal_menu();
			self.close_turn_menu();
			self.close_row_menu();
			self.return_menu_focus(window, cx);
			self.palette_input.menu_focused = false;
		}
		let was_open = self.state.menu.open.is_some();
		self.dispatch(Intent::SetMenuSection(section), cx);
		let open = self.state.menu.open.is_some();
		if open && !was_open {
			self.take_menu_focus(window, cx);
		} else if !open && was_open {
			self.return_menu_focus(window, cx);
		}
	}

	/// Records where the focus was and gives it to the open menu, so a bare
	/// arrow or Return reaches the bar rather than the region under it.
	pub(super) fn take_menu_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let held = self.menu_focus.as_ref();
		let focused = window.focused(cx);
		if focused.as_ref() != held {
			self.menu_return = focused;
		}
		let focus = self.menu_focus(cx);
		window.focus(&focus, cx);
	}

	/// Gives the focus back to whatever held it before the bar took it.
	pub(super) fn return_menu_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if let Some(focus) = self.menu_return.take() {
			window.focus(&focus, cx);
		}
	}

	/// Closes the open menu, reporting whether one was open.
	///
	/// The rung Escape takes: the press that closes the bar leaves every
	/// surface under it where it was, and the focus goes back where the bar
	/// found it.
	pub fn close_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
		if self.state.menu.open.is_none() {
			return false;
		}
		self.state.menu.close();
		self.return_menu_focus(window, cx);
		cx.notify();
		true
	}

	/// Closes the bar and dispatches `command` as the action its chord
	/// dispatches.
	///
	/// A verb the host declined is not taken: the entry is drawn refused and
	/// answers no click, and a chord that reaches here with the same verb
	/// declined stops here too.
	///
	/// The focus goes back before the action is dispatched, because a verb is
	/// dispatched on the focused element: run from the bar, `Primary` belongs
	/// to the composer the bar took the focus from and not to the bar.
	pub fn run_menu_command(
		&mut self,
		command: Command,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if !self.state.menu.enabled(command) {
			return;
		}
		self.state.menu.close();
		self.return_menu_focus(window, cx);
		cx.notify();
		match build_action(command.name(), None) {
			Ok(action) => window.dispatch_action(action.boxed_clone(), cx),
			// Every entry of the table builds with no argument, which the
			// command-reach sweep pins. A failure here is that invariant
			// broken, and it is stated rather than swallowed.
			Err(error) => self.set_notice(Some(error.to_string()), cx),
		}
	}
}

/// The keystrokes the open menu answers, for the root's capture phase.
///
/// The open menu holds the keyboard: the four arrows walk it, Return takes the
/// entry the walk is on, and nothing under it reads the press. A walk is
/// dispatched rather than applied, so one press is one intent.
pub(super) fn menu_keys(
	cx: &Context<ShellView>,
) -> impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static {
	cx.listener(|view, event: &KeyDownEvent, window, cx| {
		if !view.menu_picker_key(event.keystroke.key.as_str(), window, cx) {
			return;
		}
		cx.stop_propagation();
		cx.notify();
	})
}

/// The bar's words, drawn in the titlebar after the rail control.
///
/// A press opens the section under the word, and a second press on the same
/// word closes it. The word the open section belongs to carries the selected
/// wash, so the bar states which menu is down without the float being the
/// only evidence.
pub(super) fn menu_bar(
	menu: &MenuState,
	anchors: MenuAnchors,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut row = div()
		.flex()
		.flex_row()
		.items_center()
		.flex_shrink_0()
		.gap(tokens.spacing(SpacingStep::S1));

	for section in MenuSectionId::iter() {
		let open = menu.open == Some(section);
		let mut word = div()
			.id(section.title())
			.px(tokens.spacing(SpacingStep::S3))
			.py(tokens.spacing(SpacingStep::S1))
			.rounded(tokens.radius(RadiusStep::Sm))
			.text_size(tokens.font_size(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Secondary))
			.cursor_pointer()
			.child(section.title());
		if open {
			word = word
				.bg(tokens.row_selected())
				.text_color(tokens.color(ColorRole::Foreground));
		} else {
			word = word.hover(|style| style.bg(tokens.row_hover()));
		}
		row = row.child(word.on_mouse_down(
			MouseButton::Left,
			cx.listener(move |view, _event, window, cx| {
				view.toggle_menu_section(Some(section), window, cx);
			}),
		));
	}

	row.on_children_prepainted(move |children, _window, _cx| {
		let mut origins = Vec::with_capacity(children.len());
		for bounds in children {
			origins.push(point(bounds.origin.x, bounds.origin.y + bounds.size.height));
		}
		*anchors.borrow_mut() = origins;
	})
}

/// The layer drawn over the window while a menu is open: a scrim that takes
/// the dismissing press, and the section floated under its word.
///
/// The scrim occludes what it covers, so one press is one answer: a press on
/// the word of the open section closes the bar instead of closing and
/// reopening it, and a press anywhere else dismisses without also reaching
/// the control it landed on. The floated card occludes in turn, so a row
/// inside the open menu still answers its own press.
///
/// Absent while the bar is closed, so a shut bar costs one comparison and no
/// element.
pub(super) fn menu_layer(
	view: &mut ShellView,
	cx: &mut Context<ShellView>,
) -> Option<impl IntoElement> {
	let section = view.state().menu.open?;
	let items = view
		.menu_picker_rows(crate::menu::MenuSource::Bar)
		.into_iter()
		.map(|(item, _)| item);
	let entity = cx.entity();
	let picker = Menu::new(items).on_select(move |index, _event, window, app| {
		entity.update(app, |view, cx| {
			view.menu_picker_pointer(crate::menu::MenuSource::Bar, index, window, cx);
		});
	});

	let origin = view
		.menu_anchors()
		.borrow()
		.get(section_index(section))
		.copied()
		.unwrap_or_else(|| point(px(0.0), px(0.0)));
	// The card holds the focus the bar took, so the keystrokes the region
	// underneath would answer are not dispatched against it.
	let focus = view.menu_focus(cx);

	Some(
		div()
			.id("titlebar-menu-scrim")
			.absolute()
			.inset_0()
			.occlude()
			.on_mouse_down(
				MouseButton::Left,
				cx.listener(|view, _event, window, cx| {
					view.toggle_menu_section(None, window, cx);
				}),
			)
			.on_mouse_down(
				MouseButton::Right,
				cx.listener(|view, _event, window, cx| {
					view.toggle_menu_section(None, window, cx);
				}),
			)
			.child(
				Popover::new(origin, AnchorCorner::TopLeft, picker)
					.id("titlebar-menu")
					.focus(&focus),
			),
	)
}

/// Where `section` sits along the bar, which is the index its recorded origin
/// is held at.
fn section_index(section: MenuSectionId) -> usize {
	MenuSectionId::iter()
		.position(|candidate| candidate == section)
		.unwrap_or(0)
}
