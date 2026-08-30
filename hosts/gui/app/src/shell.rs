//! The window: what is on screen, what the keyboard does, and the frame clock.
//!
//! One view holds the whole app. The store is a field rather than its own
//! entity, because every surface reads all of it and nothing reads only part of
//! it, so a second entity would buy an extra notify path and no isolation.
//!
//! THE FRAME. Each render stamps one `now`, hands it to `moves::tick` and to
//! the motion registry, draws from what they leave behind, and asks for exactly
//! one more frame if either says something is still moving. Nothing else in the
//! window schedules a frame, so a window with nothing happening in it draws
//! nothing.
//!
//! THE SHAPE. Two columns, and each carries its own header: the sidebar's
//! header holds the window controls, the content's header holds what is on
//! screen and the ways out of it. A window-wide titlebar across both would put
//! a chrome-coloured band over the content column and cost the content its top
//! corner; splitting it is what every document application on the machine does.
//!
//! WHAT LIVES HERE, AND WHAT DOES NOT. The two headers, the column layout, the
//! sidebar's drag handle, and the keymap's actions. The regions themselves are
//! the sibling modules, as functions over this view.

use std::time::Instant;

use gpui::{
	App, AppContext, Context, CursorStyle, Decorations, Div, Entity, FocusHandle, Focusable,
	InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement,
	Pixels, Render, ResizeEdge, ScrollHandle, Stateful, StatefulInteractiveElement, Styled, Window,
	actions, div, prelude::FluentBuilder, px,
};

use crate::{
	composer,
	input::{Editor, EditorEvent},
	motion::{self, Channel, Key, Motion},
	palette, settings, sidebar,
	state::{
		model::{Route, SIDEBAR_MIN, SessionId, Store},
		moves,
	},
	theme::{Theme, layout, radius, size, space},
	transcript, ui,
};

actions!(shell, [
	ToggleSidebar,
	NewSession,
	DeleteSession,
	OpenPalette,
	OpenSettings,
	CycleNext,
	CyclePrev,
	FlipAppearance,
	Cancel,
	PaletteUp,
	PaletteDown,
	PaletteAccept,
	FocusComposer,
]);

/// The sidebar's edge being dragged. Holds where the pointer went down and how
/// wide the sidebar was then, so the width follows the hand exactly rather than
/// jumping by the distance from the edge to the grab point.
#[derive(Debug, Clone, Copy)]
struct Drag {
	from_x: f32,
	width:  f32,
}

pub struct Shell {
	pub store:      Store,
	pub motion:     Motion,
	/// The composer's field. Lives here rather than in the composer module
	/// because it outlives any one frame and holds the caret.
	pub composer:   Entity<Editor>,
	/// The palette's field.
	pub search:     Entity<Editor>,
	/// The window's own clock. Every deadline in the store and every channel in
	/// the registry is measured against it.
	opened:         Instant,
	/// This frame's instant, in milliseconds since the window opened.
	pub now:        u64,
	/// The transcript's scroll, held here so the autoscroll can read where the
	/// reader is rather than assuming they are at the bottom.
	pub transcript: ScrollHandle,
	/// The window's own focus target, for a route that draws no field. Without
	/// it the settings pages would take no keystrokes at all: a binding
	/// dispatches along the focused element's ancestors, and with the composer
	/// unmounted there is no focused element to walk up from.
	focus:          FocusHandle,
	drag:           Option<Drag>,
}

impl Shell {
	pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
		let composer = cx.new(|cx| Editor::new("Write a message", true, cx).heights(24.0, 220.0));
		let search = cx.new(|cx| {
			Editor::new("Search conversations and commands", false, cx)
				.context("PaletteSearch")
				.heights(24.0, 24.0)
		});

		cx.subscribe(&composer, Self::on_composer).detach();
		cx.subscribe(&search, Self::on_search).detach();

		let shell = Shell {
			store: opened_store(),
			motion: Motion::new(),
			composer,
			search,
			opened: Instant::now(),
			now: 0,
			transcript: ScrollHandle::new(),
			focus: cx.focus_handle(),
			drag: None,
		};
		// The window opens ready to be typed into.
		shell.settle_focus(window, cx);
		shell
	}

	/// Now, on the window's clock.
	fn stamp(&self) -> u64 {
		self.opened.elapsed().as_millis() as u64
	}

	// ---- the composer and the palette field report through here ----

	fn on_composer(&mut self, editor: Entity<Editor>, event: &EditorEvent, cx: &mut Context<Self>) {
		let now = self.stamp();
		self.store.now_ms = now;
		match event {
			EditorEvent::Changed => {
				let (text, caret) = editor
					.read(cx)
					.pipe(|editor| (editor.text().to_owned(), editor.caret()));
				moves::set_draft(&mut self.store, text, caret);
			},
			EditorEvent::Submit => {
				if moves::send(&mut self.store) {
					editor.update(cx, |editor, cx| editor.clear(cx));
					// The column is anchored to the composer, so a conversation
					// past one screen has its newest line below the fold until
					// the scroll is moved there.
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
				moves::palette_query(&mut self.store, query);
			},
			EditorEvent::Submit => self.accept_palette(cx),
		}
		cx.notify();
	}

	// ---- actions ----

	fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
		moves::toggle_sidebar(&mut self.store);
		cx.notify();
	}

	fn new_session(&mut self, _: &NewSession, window: &mut Window, cx: &mut Context<Self>) {
		self.start_session(window, cx);
	}

	pub fn start_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		moves::new_session(&mut self.store);
		moves::close_settings(&mut self.store);
		self.show_selected(cx);
		Editor::focus(&self.composer, window, cx);
		cx.notify();
	}

	fn delete_session(&mut self, _: &DeleteSession, _: &mut Window, cx: &mut Context<Self>) {
		moves::run_action(&mut self.store, "delete-session");
		self.show_selected(cx);
		cx.notify();
	}

	fn open_palette(&mut self, _: &OpenPalette, window: &mut Window, cx: &mut Context<Self>) {
		self.show_palette(window, cx);
	}

	pub fn show_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		moves::open_palette(&mut self.store);
		self.search.update(cx, |editor, cx| editor.clear(cx));
		Editor::focus(&self.search, window, cx);
		cx.notify();
	}

	fn open_settings(&mut self, _: &OpenSettings, _: &mut Window, cx: &mut Context<Self>) {
		moves::run_action(&mut self.store, "settings");
		cx.notify();
	}

	fn cycle_next(&mut self, _: &CycleNext, _: &mut Window, cx: &mut Context<Self>) {
		moves::cycle(&mut self.store, true);
		self.show_selected(cx);
		cx.notify();
	}

	fn cycle_prev(&mut self, _: &CyclePrev, _: &mut Window, cx: &mut Context<Self>) {
		moves::cycle(&mut self.store, false);
		self.show_selected(cx);
		cx.notify();
	}

	fn flip_appearance(&mut self, _: &FlipAppearance, _: &mut Window, cx: &mut Context<Self>) {
		moves::run_action(&mut self.store, "flip-appearance");
		Theme::set(self.store.settings.appearance, cx);
		cx.notify();
	}

	/// Escape, which closes whatever is on top of the conversation.
	fn cancel(&mut self, _: &Cancel, window: &mut Window, cx: &mut Context<Self>) {
		if self.store.overlay.is_open() {
			moves::close_overlay(&mut self.store);
			Editor::focus(&self.composer, window, cx);
		} else if !matches!(self.store.route, Route::Chat) {
			moves::close_settings(&mut self.store);
		}
		cx.notify();
	}

	fn palette_up(&mut self, _: &PaletteUp, _: &mut Window, cx: &mut Context<Self>) {
		moves::palette_move(&mut self.store, -1);
		cx.notify();
	}

	fn palette_down(&mut self, _: &PaletteDown, _: &mut Window, cx: &mut Context<Self>) {
		moves::palette_move(&mut self.store, 1);
		cx.notify();
	}

	fn palette_accept(&mut self, _: &PaletteAccept, _: &mut Window, cx: &mut Context<Self>) {
		self.accept_palette(cx);
	}

	fn focus_composer(&mut self, _: &FocusComposer, window: &mut Window, cx: &mut Context<Self>) {
		Editor::focus(&self.composer, window, cx);
	}

	/// Keep the keyboard on something this route draws.
	///
	/// A binding dispatches along the focused element's ancestors, so a window
	/// whose focused element is not in the tree receives nothing. Two moves put
	/// it there: opening the settings pages unmounts the composer, and a click
	/// on chrome moves focus to the window itself, which is a key context but
	/// no text field. Every route change ends here rather than at each caller,
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

	fn accept_palette(&mut self, cx: &mut Context<Self>) {
		moves::palette_accept(&mut self.store);
		Theme::set(self.store.settings.appearance, cx);
		self.show_selected(cx);
		cx.notify();
	}

	/// The selected conversation changed: put its draft in the composer and open
	/// its transcript at the end.
	///
	/// A draft belongs to its conversation, so switching changes what is in the
	/// field; the caret comes with it, because a draft that reopens with the
	/// caret at zero has to be re-navigated every time. The scroll offset
	/// belongs to the column rather than to the conversation, so without the
	/// second move a long conversation opens at the offset the last one was
	/// read at.
	pub fn show_selected(&mut self, cx: &mut Context<Self>) {
		let (text, caret) = self
			.store
			.selected_session()
			.map(|session| (session.draft.clone(), session.caret))
			.unwrap_or_default();
		self
			.composer
			.update(cx, |editor, cx| editor.set_text(&text, caret, cx));
		self.transcript.scroll_to_bottom();
	}

	/// Select a conversation from a click, keeping the composer in step.
	pub fn select(&mut self, id: &SessionId, cx: &mut Context<Self>) {
		moves::select(&mut self.store, id);
		self.show_selected(cx);
		cx.notify();
	}

	// ---- the drag handle ----

	fn begin_drag(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
		if event.click_count > 1 {
			moves::reset_sidebar_width(&mut self.store);
			self.store.settings.sidebar_open = true;
			cx.notify();
			return;
		}
		self.drag = Some(Drag {
			from_x: f32::from(event.position.x),
			width:  self.store.settings.sidebar_width,
		});
	}

	fn drag_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
		let Some(Drag { from_x, width }) = self.drag else {
			return;
		};
		let now = self.stamp();
		let target = width + (f32::from(event.position.x) - from_x);
		// A drag past the minimum closes the sidebar rather than sticking at
		// the minimum, and dragging back out reopens it.
		if target < SIDEBAR_MIN - 40.0 {
			self.store.settings.sidebar_open = false;
		} else {
			self.store.settings.sidebar_open = true;
			moves::set_sidebar_width(&mut self.store, target);
		}
		let width = self.sidebar_target();
		self.motion.snap(Key::of(Channel::SidebarWidth), width, now);
		cx.notify();
	}

	fn end_drag(&mut self, cx: &mut Context<Self>) {
		if self.drag.take().is_some() {
			cx.notify();
		}
	}

	fn sidebar_target(&self) -> f32 {
		if self.store.settings.sidebar_open {
			self.store.settings.sidebar_width
		} else {
			0.0
		}
	}

	// ---- headers ----

	/// The three circles that close, minimize and zoom the window.
	///
	/// macOS draws its own into the frameless titlebar, so this is the same set
	/// for the platforms where the app owns its frame. They are the platform's
	/// order and the platform's colours; a window with no border needs them to
	/// be findable without hunting.
	fn window_controls(&mut self, window: &Window, cx: &mut Context<Self>) -> Option<Div> {
		if cfg!(target_os = "macos")
			|| !matches!(window.window_decorations(), Decorations::Client { .. })
		{
			return None;
		}
		let theme = Theme::get(cx);
		let control = |id: &'static str,
		               color: gpui::Hsla,
		               action: fn(&mut Window),
		               shell: &mut Self,
		               cx: &mut Context<Self>| {
			let key = Key::named(Channel::Control, id);
			let lit = shell.motion.value(key, shell.now);
			div()
				.id(id)
				.size(px(layout::CONTROL))
				.rounded(px(radius::PILL))
				.bg(motion::mix(color.opacity(0.55), color, lit))
				.cursor_pointer()
				.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
				.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
					let now = shell.stamp();
					shell.motion.flip(key, *hovered, motion::WASH, now);
					window.refresh();
				}))
				.on_click(move |_, window: &mut Window, _| action(window))
		};
		let close = control("win-close", theme.danger, |window| window.remove_window(), self, cx);
		let minimize = control(
			"win-minimize",
			gpui::hsla(0.13, 0.85, 0.60, 1.0),
			|window| window.minimize_window(),
			self,
			cx,
		);
		let zoom = control(
			"win-zoom",
			gpui::hsla(0.33, 0.55, 0.52, 1.0),
			|window| window.zoom_window(),
			self,
			cx,
		);
		Some(
			ui::line_of(space::BASE)
				.flex_none()
				.child(close)
				.child(minimize)
				.child(zoom),
		)
	}

	/// A header, at the top of either column. Drags the window, zooms on a
	/// double click, and carries whatever the column puts in it.
	fn header(&self, id: &'static str) -> Stateful<Div> {
		div()
			.id(id)
			.flex()
			.items_center()
			.flex_none()
			.h(px(layout::TITLEBAR))
			.w_full()
			.gap(px(space::BASE))
			.on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
				if event.click_count > 1 {
					window.zoom_window();
				} else {
					window.start_window_move();
				}
			})
	}

	/// The content column's header: what is on screen, and the way out of it.
	fn content_header(&mut self, window: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
		let theme = Theme::get(cx);
		let sidebar_open = self.store.settings.sidebar_open;
		let controls = (!sidebar_open)
			.then(|| self.window_controls(window, cx))
			.flatten();

		let (title, subtitle) = match self.store.route {
			Route::Chat => {
				let session = self.store.selected_session();
				(
					session
						.map(|session| session.title.clone())
						.unwrap_or_default(),
					session
						.filter(|session| !session.messages.is_empty())
						.map(|session| match session.messages.len() {
							1 => "1 message".to_owned(),
							count => format!("{count} messages"),
						}),
				)
			},
			Route::Settings(_) => ("Settings".to_owned(), None),
		};

		let leave = matches!(self.store.route, Route::Settings(_)).then(|| {
			self.header_button(
				"leave-settings",
				ui::glyph::CLOSE,
				cx.listener(|shell, _, _, cx| {
					moves::close_settings(&mut shell.store);
					cx.notify();
				}),
				cx,
			)
		});
		let sidebar_toggle = (!sidebar_open).then(|| {
			self.header_button(
				"show-sidebar",
				ui::glyph::SIDEBAR,
				cx.listener(|shell, _, _, cx| {
					moves::toggle_sidebar(&mut shell.store);
					cx.notify();
				}),
				cx,
			)
		});
		// The sidebar header owns this while the column is open; here it is the
		// same button for a window that has no sidebar to put it in.
		let new = (!sidebar_open && matches!(self.store.route, Route::Chat)).then(|| {
			self.header_button(
				"new-conversation-alone",
				ui::glyph::NEW,
				cx.listener(|shell, _, window, cx| shell.start_session(window, cx)),
				cx,
			)
		});

		self
			.header("content-header")
			.px(px(space::WIDE))
			.children(controls)
			.children(sidebar_toggle)
			.child(
				div()
					.flex()
					.flex_col()
					.flex_1()
					.min_w(px(0.0))
					.child(
						ui::line(title)
							.text_size(px(size::BODY))
							.font_weight(gpui::FontWeight::MEDIUM)
							.text_color(theme.text),
					)
					.children(subtitle.map(|subtitle| {
						ui::line(subtitle)
							.text_size(px(size::META))
							.text_color(theme.text_faint)
					})),
			)
			.children(new)
			.children(leave)
	}

	/// One control in a header: hover-washed, and not part of the drag region,
	/// because a button that moves the window is not a button.
	fn header_button(
		&mut self,
		id: &'static str,
		glyph: &'static str,
		click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
		cx: &mut Context<Self>,
	) -> Stateful<Div> {
		let theme = Theme::get(cx);
		let key = Key::named(Channel::Control, id);
		let ground =
			ui::wash(&mut self.motion, key, gpui::transparent_black(), theme.hover(), self.now);
		ui::button(id, glyph, &theme, ground)
			.flex_none()
			.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
			.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
				let now = shell.stamp();
				shell.motion.flip(key, *hovered, motion::WASH, now);
				window.refresh();
			}))
			.on_click(click)
	}

	/// The strip between the two columns that resizes them.
	fn handle(&mut self, cx: &mut Context<Self>) -> Stateful<Div> {
		div()
			.id("sidebar-handle")
			.w(px(layout::HANDLE))
			.h_full()
			.flex_none()
			.cursor(CursorStyle::ResizeLeftRight)
			.on_mouse_down(
				MouseButton::Left,
				cx.listener(|shell, event: &MouseDownEvent, _, cx| shell.begin_drag(event, cx)),
			)
	}

	/// While a drag is live, one surface over the whole window takes every
	/// pointer event.
	///
	/// The alternative is a global mouse listener, which then has to work out
	/// whether it is the one that should care. A drag is modal by nature, so
	/// drawing it as a modal surface is both simpler and correct at the edges:
	/// the pointer leaving the handle, leaving the window, or landing on a row
	/// that would otherwise light up under it.
	fn drag_surface(&mut self, cx: &mut Context<Self>) -> Option<Div> {
		self.drag?;
		Some(
			div()
				.absolute()
				.inset_0()
				.cursor(CursorStyle::ResizeLeftRight)
				.on_mouse_move(cx.listener(|shell, event: &MouseMoveEvent, _, cx| {
					shell.drag_move(event, cx);
				}))
				.on_mouse_up(MouseButton::Left, cx.listener(|shell, _, _, cx| shell.end_drag(cx)))
				.on_mouse_up_out(MouseButton::Left, cx.listener(|shell, _, _, cx| shell.end_drag(cx))),
		)
	}

	/// The edges a frameless window is resized by.
	fn resize_edges(&self, window: &Window) -> Option<Div> {
		if !matches!(window.window_decorations(), Decorations::Client { .. }) {
			return None;
		}
		let edge = |id: &'static str, edge: ResizeEdge| {
			div().id(id).absolute().on_mouse_down(
				MouseButton::Left,
				move |_, window: &mut Window, cx| {
					window.start_window_resize(edge);
					cx.stop_propagation();
				},
			)
		};
		const T: Pixels = px(4.0);
		Some(
			div()
				.absolute()
				.inset_0()
				.child(
					edge("edge-top", ResizeEdge::Top)
						.top_0()
						.left_0()
						.right_0()
						.h(T),
				)
				.child(
					edge("edge-bottom", ResizeEdge::Bottom)
						.bottom_0()
						.left_0()
						.right_0()
						.h(T),
				)
				.child(
					edge("edge-left", ResizeEdge::Left)
						.top_0()
						.bottom_0()
						.left_0()
						.w(T),
				)
				.child(
					edge("edge-right", ResizeEdge::Right)
						.top_0()
						.bottom_0()
						.right_0()
						.w(T),
				),
		)
	}
}

impl Focusable for Shell {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for Shell {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		// One instant for the whole frame. Everything below reads it; nothing
		// below asks the clock again.
		self.now = self.stamp();
		let now = self.now;
		self.store.now_ms = now;
		self.motion.set_reduced(cx.reduce_motion());
		let store_moved = moves::tick(&mut self.store, now);

		let theme = Theme::get(cx);
		let sidebar_width = self.motion.drive(
			Key::of(Channel::SidebarWidth),
			motion::RESIZE,
			self.sidebar_target(),
			now,
		);

		self.settle_focus(window, cx);

		let sidebar_header = self.sidebar_header(window, cx);
		let sidebar = sidebar::render(self, cx);
		let content_header = self.content_header(window, cx);
		let main = match self.store.route {
			Route::Chat => transcript::render(self, cx).into_any_element(),
			Route::Settings(page) => settings::render(self, page, cx).into_any_element(),
		};
		let composer = matches!(self.store.route, Route::Chat)
			.then(|| composer::render(self, window, cx).into_any_element());
		let handle = self.handle(cx);
		let overlay = palette::render(self, cx);
		let drag_surface = self.drag_surface(cx);
		let resize_edges = self.resize_edges(window);

		let body = div()
			.flex()
			.flex_1()
			.min_h(px(0.0))
			.w_full()
			.child(
				div()
					.flex()
					.flex_col()
					.flex_none()
					.w(px(sidebar_width))
					.h_full()
					.overflow_hidden()
					.child(sidebar_header)
					.child(sidebar),
			)
			.child(handle)
			.child(
				div()
					.flex()
					.flex_col()
					.flex_1()
					.min_w(px(0.0))
					.h_full()
					.overflow_hidden()
					.bg(theme.canvas)
					.child(content_header)
					.child(
						div()
							.flex()
							.flex_col()
							.flex_1()
							.min_h(px(0.0))
							.overflow_hidden()
							.child(main),
					)
					.children(composer),
			);

		// The frame tail. Everything that moves has been read by now, so the
		// registry can retire what nobody looked at and say whether another
		// frame is owed. The notice is the one thing in the store with a
		// deadline of its own, so it is folded in here.
		let motion_moved = self.motion.advance(now);
		let mut next_frame = self.motion.next_frame_after(now);
		if let Some(until) = self.store.deadline() {
			let wait = until.saturating_sub(now) as u32;
			next_frame = Some(next_frame.map_or(wait, |soonest| soonest.min(wait)));
		}
		match next_frame {
			Some(0) => window.request_animation_frame(),
			Some(wait) => self.schedule(wait, cx),
			None if store_moved || motion_moved => window.request_animation_frame(),
			None => {},
		}

		// The window's key context, and its focus target of last resort. A
		// focusable ancestor takes the keyboard on any click that lands in it,
		// which is every click on chrome: a sidebar row, the composer's
		// padding. `settle_focus` hands it straight back to the field the route
		// draws, and keeps it here only while the route draws none.
		div()
			.key_context("Shell")
			.track_focus(&self.focus)
			.relative()
			.size_full()
			.flex()
			.flex_col()
			.bg(theme.chrome)
			.text_color(theme.text)
			.text_size(px(size::BODY))
			.line_height(px(size::BODY * size::LINE))
			.font_family(theme.font_ui)
			.when(matches!(window.window_decorations(), Decorations::Client { .. }), |element| {
				element.rounded(px(radius::SHEET)).overflow_hidden()
			})
			.on_action(cx.listener(Self::toggle_sidebar))
			.on_action(cx.listener(Self::new_session))
			.on_action(cx.listener(Self::delete_session))
			.on_action(cx.listener(Self::open_palette))
			.on_action(cx.listener(Self::open_settings))
			.on_action(cx.listener(Self::cycle_next))
			.on_action(cx.listener(Self::cycle_prev))
			.on_action(cx.listener(Self::flip_appearance))
			.on_action(cx.listener(Self::cancel))
			.on_action(cx.listener(Self::palette_up))
			.on_action(cx.listener(Self::palette_down))
			.on_action(cx.listener(Self::palette_accept))
			.on_action(cx.listener(Self::focus_composer))
			.child(body)
			.children(overlay)
			.children(drag_surface)
			.children(resize_edges)
	}
}

impl Shell {
	/// The sidebar column's header: the window controls, the two ways into the
	/// list under it, and the toggle that hides the column they sit in.
	fn sidebar_header(&mut self, window: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
		let controls = self
			.store
			.settings
			.sidebar_open
			.then(|| self.window_controls(window, cx))
			.flatten();
		let search = self.header_button(
			"search-conversations",
			ui::glyph::SEARCH,
			cx.listener(|shell, _, window, cx| shell.show_palette(window, cx)),
			cx,
		);
		let new = self.header_button(
			"new-conversation",
			ui::glyph::NEW,
			cx.listener(|shell, _, window, cx| shell.start_session(window, cx)),
			cx,
		);
		let hide = self.header_button(
			"hide-sidebar",
			ui::glyph::SIDEBAR,
			cx.listener(|shell, _, _, cx| {
				moves::toggle_sidebar(&mut shell.store);
				cx.notify();
			}),
			cx,
		);
		self
			.header("sidebar-header")
			.pl(px(space::WIDE))
			.pr(px(space::BASE))
			.children(controls)
			.child(ui::spacer())
			.child(search)
			.child(new)
			.child(hide)
	}

	/// Ask for a frame in `wait` milliseconds. What a repeating indicator gets,
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

/// A small convenience for reading two things out of an entity in one
/// expression, so a borrow does not have to be named.
trait Pipe {
	fn pipe<R>(&self, f: impl FnOnce(&Self) -> R) -> R {
		f(self)
	}
}

impl<T> Pipe for T {}
