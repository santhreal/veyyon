//! The window: what is on screen, and the one place a command is carried out.
//!
//! One view holds the whole app. The store is a field rather than its own
//! entity, because every surface reads all of it and nothing reads only part of
//! it, so a second entity would buy an extra notify path and no isolation.
//!
//! THIS FILE HAS ONE LISTENER. Every press, every keystroke and every palette
//! row arrives as [`Do`](veyyon_gui_features::act::Do), carrying a
//! [`Command`]. It runs against the store, and the few effects a store cannot
//! perform on itself come back as an [`Outcome`] that [`Shell::perform`]
//! carries out: where the caret goes, whether the field takes the store's draft
//! again, whether the transcript moves, whether the window closes. A new
//! command needs no wiring here at all.
//!
//! THE FRAME. Each render stamps one instant, hands it to `moves::tick` and to
//! the motion registry, draws from what they leave behind, and asks for exactly
//! one more frame if either says something is still moving. Nothing else in the
//! window schedules a frame, so a window with nothing happening in it draws
//! nothing.
//!
//! THE SHAPE. Two columns, each carrying its own header. A window-wide titlebar
//! across both would put a chrome-coloured band over the content column and
//! cost it its top corner; splitting it is what every document application on
//! the machine does. The headers, the window controls, the drag handle and the
//! resize edges are [`chrome`](crate::chrome); the regions are the feature
//! crate.

use std::time::Instant;

use gpui::{
	App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
	MouseDownEvent, MouseMoveEvent, ParentElement, Render, ScrollHandle, Styled, Window, div,
	prelude::FluentBuilder, px,
};
use veyyon_gui_core::{
	command::{Command, Focus, Outcome},
	store::{
		model::{Route, SIDEBAR_MIN, Store},
		moves,
	},
};
use veyyon_gui_features::{act::Do, composer, palette, settings, sidebar, transcript};
use veyyon_gui_kit::{
	input::{Editor, EditorEvent},
	motion::{self, Channel, Key},
	paint,
	theme::{Theme, radius, size},
	ui::scrollbar,
};

use crate::chrome;

mod drag;
mod frame;

/// The sidebar's edge being dragged. Holds where the pointer went down and how
/// wide the sidebar was then, so the width follows the hand exactly rather than
/// jumping by the distance from the edge to the grab point.
#[derive(Debug, Clone, Copy)]
pub struct Drag {
	pub from_x: f32,
	pub width:  f32,
}

pub struct Shell {
	pub store:      Store,
	/// The composer's field. Lives here rather than in the composer surface
	/// because it outlives any one frame and holds the caret.
	pub composer:   Entity<Editor>,
	/// The palette's field.
	pub search:     Entity<Editor>,
	/// The window's own clock. Every deadline in the store and every channel in
	/// the motion registry is measured against it.
	opened:         Instant,
	/// This frame's instant, in milliseconds since the window opened.
	pub now:        u64,
	/// The transcript's scroll, held here because a send has to move it and a
	/// surface drawn from a value cannot hold it between frames.
	pub transcript: ScrollHandle,
	/// The settings page's scroll.
	pub page:       ScrollHandle,
	/// The window's own focus target, for a route that draws no field. Without
	/// it the settings pages would take no keystrokes at all: a binding
	/// dispatches along the focused element's ancestors, and with the composer
	/// unmounted there is no focused element to walk up from.
	focus:          FocusHandle,
	pub drag:       Option<Drag>,
}

impl Shell {
	pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
		let composer = cx.new(|cx| Editor::new(composer::PLACEHOLDER, true, cx).heights(24.0, 220.0));
		let search = cx.new(|cx| {
			Editor::new("Search conversations and commands", false, cx)
				.context("PaletteSearch")
				.heights(24.0, 24.0)
		});

		cx.subscribe(&composer, Self::on_composer).detach();
		cx.subscribe(&search, Self::on_search).detach();

		let shell = Shell {
			store: opened_store(),
			composer,
			search,
			opened: Instant::now(),
			now: 0,
			transcript: ScrollHandle::new(),
			page: ScrollHandle::new(),
			focus: cx.focus_handle(),
			drag: None,
		};
		// The window opens ready to be typed into.
		shell.settle_focus(window, cx);
		shell
	}

	/// Now, on the window's clock.
	pub fn stamp(&self) -> u64 {
		self.opened.elapsed().as_millis() as u64
	}

	// ---- the one listener ----

	fn act(&mut self, action: &Do, window: &mut Window, cx: &mut Context<Self>) {
		self.perform(action.0.clone(), window, cx);
	}

	/// Run a command, and carry out what the store could not.
	///
	/// The only path from anything a reader does to the store. Two things are
	/// read back rather than announced by the outcome, because they are facts
	/// about the store rather than requests: the appearance, which the palette
	/// follows, and the conversation on screen, whose draft the field holds.
	pub fn perform(&mut self, command: Command, window: &mut Window, cx: &mut Context<Self>) {
		self.store.now_ms = self.stamp();
		let appearance = self.store.settings.appearance;
		let opening_palette = matches!(command, Command::OpenPalette);

		let Outcome { focus, draft_changed, scroll_to_latest, quit } = command.run(&mut self.store);

		if self.store.settings.appearance != appearance {
			Theme::set(self.store.settings.appearance, cx);
		}
		if draft_changed {
			let (text, caret) = self
				.store
				.selected_session()
				.map(|session| (session.draft.clone(), session.caret))
				.unwrap_or_default();
			self
				.composer
				.update(cx, |editor, cx| editor.set_text(&text, caret, cx));
		}
		if scroll_to_latest {
			self.transcript.scroll_to_bottom();
		}
		if opening_palette {
			// The field is emptied when the palette opens rather than when it
			// closes: a palette that reopens holding the last query answers a
			// question nobody asked twice.
			self.search.update(cx, |editor, cx| editor.clear(cx));
		}
		match focus {
			Some(Focus::Composer) => Editor::focus(&self.composer, window, cx),
			Some(Focus::Palette) => Editor::focus(&self.search, window, cx),
			None => {},
		}
		if quit {
			cx.quit();
		}
		cx.notify();
	}

	// ---- the two fields report through here ----

	fn on_composer(&mut self, editor: Entity<Editor>, event: &EditorEvent, cx: &mut Context<Self>) {
		self.store.now_ms = self.stamp();
		match event {
			EditorEvent::Changed => {
				let editor = editor.read(cx);
				let (text, caret) = (editor.text().to_owned(), editor.caret());
				moves::set_draft(&mut self.store, text, caret);
			},
			// Return in the composer reaches the field before the window, so
			// the send arrives here rather than as a keystroke on the shell.
			EditorEvent::Submit => {
				let outcome = Command::Send.run(&mut self.store);
				if outcome.draft_changed {
					editor.update(cx, |editor, cx| editor.clear(cx));
					self.transcript.scroll_to_bottom();
				}
			},
		}
		cx.notify();
	}

	fn on_search(&mut self, editor: Entity<Editor>, event: &EditorEvent, cx: &mut Context<Self>) {
		match event {
			EditorEvent::Changed => {
				let query = editor.read(cx).text().to_owned();
				Command::PaletteQuery(query).run(&mut self.store);
			},
			EditorEvent::Submit => {
				// The palette's own Return. Its outcome may carry anything the
				// accepted command asked for, so it goes through the one path.
				let outcome = Command::AcceptPalette.run(&mut self.store);
				self.after_palette(outcome, cx);
			},
		}
		cx.notify();
	}

	/// What the palette's Return needs that a subscription cannot ask a window
	/// for: the appearance, the field, and the transcript.
	fn after_palette(&mut self, outcome: Outcome, cx: &mut Context<Self>) {
		Theme::set(self.store.settings.appearance, cx);
		if outcome.draft_changed {
			let (text, caret) = self
				.store
				.selected_session()
				.map(|session| (session.draft.clone(), session.caret))
				.unwrap_or_default();
			self
				.composer
				.update(cx, |editor, cx| editor.set_text(&text, caret, cx));
		}
		if outcome.scroll_to_latest {
			self.transcript.scroll_to_bottom();
		}
		if outcome.quit {
			cx.quit();
		}
	}

	/// Keep the keyboard on something this route draws.
	///
	/// A binding dispatches along the focused element's ancestors, so a window
	/// whose focused element is not in the tree receives nothing. Two moves put
	/// it there: opening the settings pages unmounts the composer, and a click
	/// on chrome moves focus to the window itself, which is a key context but no
	/// text field. Every route change ends here rather than at each caller,
	/// because the click listeners and the field subscriptions have no other
	/// point in common.
	fn settle_focus(&self, window: &mut Window, cx: &mut App) {
		let field = if self.store.overlay.is_open() {
			Some(&self.search)
		} else if matches!(self.store.route, Route::Chat) {
			Some(&self.composer)
		} else {
			None
		};
		match field {
			Some(field) if !Editor::holds_keyboard(field, window, cx) => {
				Editor::focus(field, window, cx)
			},
			Some(_) => {},
			// `Window::focus` is a no-op when the handle already holds it.
			None => window.focus(&self.focus, cx),
		}
	}

	/// Ask for a frame in `wait` milliseconds. What the notice's deadline gets,
	/// instead of the display's full rate.
	fn schedule(&self, wait: u32, cx: &mut Context<Self>) {
		cx.spawn(async move |this, cx| {
			cx.background_executor()
				.timer(std::time::Duration::from_millis(wait as u64))
				.await;
			let _ = this.update(cx, |_, cx| cx.notify());
		})
		.detach();
	}
}

/// The store the window opens with, from the directory it was launched in.
///
/// The checkout is the one fact the window has without an engine: what the
/// process was started in. A directory that cannot be read is still a window,
/// named for nothing rather than named for an invention.
fn opened_store() -> Store {
	let cwd = std::env::current_dir().unwrap_or_default();
	let name = cwd
		.file_name()
		.map(|name| name.to_string_lossy().into_owned())
		.unwrap_or_else(|| "No folder".to_owned());
	Store::opened_in(&name, &cwd.to_string_lossy())
}
