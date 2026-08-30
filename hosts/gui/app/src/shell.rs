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
//! nothing and a window with a reply arriving draws at the display's rate.
//!
//! WHAT LIVES HERE, AND WHAT DOES NOT. The titlebar, the region layout, the
//! drag handles, the status strip and the keymap's actions. The regions
//! themselves are the sibling modules, as functions over this view, so the
//! window's shape is readable in one screen.

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
	keys,
	motion::{self, Channel, Key, Motion},
	palette, settings, sidebar,
	state::{
		model::{PaletteKind, Route, SIDEBAR_MIN, Store, TERMINAL_MIN},
		moves, seed,
	},
	terminal,
	theme::{Theme, layout, radius, size, space},
	transcript, ui,
};

actions!(shell, [
	ToggleSidebar,
	ToggleTerminal,
	NewSession,
	OpenPalette,
	PickModel,
	PickTheme,
	OpenSettings,
	CycleNext,
	CyclePrev,
	Interrupt,
	FlipAppearance,
	Cancel,
	PaletteUp,
	PaletteDown,
	PaletteAccept,
	FocusComposer,
]);

/// A region being resized by the pointer.
#[derive(Debug, Clone, Copy)]
enum Drag {
	/// The sidebar's right edge. Holds where the pointer went down and how wide
	/// the sidebar was then, so the width follows the hand exactly rather than
	/// jumping by the distance from the edge to the grab point.
	Sidebar { from_x: f32, width: f32 },
	/// The terminal panel's top edge.
	Terminal { from_y: f32, height: f32 },
}

pub struct Shell {
	pub store:           Store,
	pub motion:          Motion,
	/// The composer's field. Lives here rather than in the composer module
	/// because it outlives any one frame and holds the caret.
	pub composer:        Entity<Editor>,
	/// The palette's field.
	pub search:          Entity<Editor>,
	/// The window's own clock. Every deadline in the store and every channel in
	/// the registry is measured against it.
	opened:              Instant,
	/// This frame's instant, in milliseconds since the window opened.
	pub now:             u64,
	/// The transcript's scroll, held here so the autoscroll can read where the
	/// reader is rather than assuming they are at the bottom.
	pub transcript:      ScrollHandle,
	/// The terminal panel's output scroll, for the same reason.
	pub terminal_scroll: ScrollHandle,
	/// The window's own focus target, for a route that draws no field. Without
	/// it the settings pages would take no keystrokes at all: a binding
	/// dispatches along the focused element's ancestors, and with the composer
	/// unmounted there is no focused element to walk up from.
	focus:               FocusHandle,
	drag:                Option<Drag>,
}

impl Shell {
	pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
		let composer =
			cx.new(|cx| Editor::new("Ask, or describe a change", true, cx).heights(22.0, 220.0));
		let search = cx.new(|cx| {
			Editor::new("Search sessions and commands", false, cx)
				.context("PaletteSearch")
				.heights(22.0, 22.0)
		});

		cx.subscribe(&composer, Self::on_composer).detach();
		cx.subscribe(&search, Self::on_search).detach();

		let store = seed::store();
		let shell = Shell {
			store,
			motion: Motion::new(),
			composer,
			search,
			opened: Instant::now(),
			now: 0,
			transcript: ScrollHandle::new(),
			terminal_scroll: ScrollHandle::new(),
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

	fn toggle_terminal(&mut self, _: &ToggleTerminal, _: &mut Window, cx: &mut Context<Self>) {
		moves::toggle_terminal(&mut self.store);
		cx.notify();
	}

	fn new_session(&mut self, _: &NewSession, window: &mut Window, cx: &mut Context<Self>) {
		moves::new_session(&mut self.store);
		self.pull_draft(cx);
		Editor::focus(&self.composer, window, cx);
		cx.notify();
	}

	fn open_palette(&mut self, _: &OpenPalette, window: &mut Window, cx: &mut Context<Self>) {
		self.show_palette(PaletteKind::Command, window, cx);
	}

	fn pick_model(&mut self, _: &PickModel, window: &mut Window, cx: &mut Context<Self>) {
		self.show_palette(PaletteKind::Model, window, cx);
	}

	fn pick_theme(&mut self, _: &PickTheme, window: &mut Window, cx: &mut Context<Self>) {
		self.show_palette(PaletteKind::Theme, window, cx);
	}

	pub fn show_palette(&mut self, kind: PaletteKind, window: &mut Window, cx: &mut Context<Self>) {
		moves::open_palette(&mut self.store, kind);
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
		self.pull_draft(cx);
		cx.notify();
	}

	fn cycle_prev(&mut self, _: &CyclePrev, _: &mut Window, cx: &mut Context<Self>) {
		moves::cycle(&mut self.store, false);
		self.pull_draft(cx);
		cx.notify();
	}

	fn interrupt(&mut self, _: &Interrupt, _: &mut Window, cx: &mut Context<Self>) {
		moves::interrupt(&mut self.store);
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
		} else if self
			.store
			.selected_session()
			.is_some_and(|session| session.run.is_some())
		{
			moves::interrupt(&mut self.store);
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
		self.pull_draft(cx);
		cx.notify();
	}

	/// Load the selected session's draft into the composer.
	///
	/// A draft belongs to its session, so switching sessions changes what is in
	/// the field; the caret comes with it, because a draft that reopens with the
	/// caret at zero has to be re-navigated every time.
	pub fn pull_draft(&mut self, cx: &mut Context<Self>) {
		let (text, caret) = self
			.store
			.selected_session()
			.map(|session| (session.draft.clone(), session.caret))
			.unwrap_or_default();
		self
			.composer
			.update(cx, |editor, cx| editor.set_text(&text, caret, cx));
	}

	/// Select a session from a click, keeping the composer in step.
	pub fn select(&mut self, id: &crate::state::model::SessionId, cx: &mut Context<Self>) {
		moves::select(&mut self.store, id);
		self.pull_draft(cx);
		cx.notify();
	}

	// ---- drag handles ----

	fn begin_sidebar_drag(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
		if event.click_count > 1 {
			moves::reset_sidebar_width(&mut self.store);
			self.store.settings.sidebar_open = true;
			cx.notify();
			return;
		}
		self.drag = Some(Drag::Sidebar {
			from_x: f32::from(event.position.x),
			width:  self.store.settings.sidebar_width,
		});
	}

	fn begin_terminal_drag(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
		if event.click_count > 1 {
			self.store.terminal.height = crate::state::model::TERMINAL_DEFAULT;
			cx.notify();
			return;
		}
		self.drag = Some(Drag::Terminal {
			from_y: f32::from(event.position.y),
			height: self.store.terminal.height,
		});
	}

	fn drag_move(&mut self, event: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
		let now = self.stamp();
		match self.drag {
			Some(Drag::Sidebar { from_x, width }) => {
				let target = width + (f32::from(event.position.x) - from_x);
				// A drag past the minimum closes the sidebar rather than
				// sticking at the minimum, and dragging back out reopens it.
				if target < SIDEBAR_MIN - 40.0 {
					self.store.settings.sidebar_open = false;
				} else {
					self.store.settings.sidebar_open = true;
					moves::set_sidebar_width(&mut self.store, target);
				}
				let width = self.sidebar_target();
				self.motion.snap(Key::of(Channel::SidebarWidth), width, now);
			},
			Some(Drag::Terminal { from_y, height }) => {
				let ceiling = f32::from(window.viewport_size().height) - 220.0;
				let target = height - (f32::from(event.position.y) - from_y);
				if target < TERMINAL_MIN - 40.0 {
					self.store.terminal.open = false;
				} else {
					self.store.terminal.open = true;
					moves::set_terminal_height(&mut self.store, target, ceiling.max(TERMINAL_MIN));
				}
				let height = self.terminal_target();
				self
					.motion
					.snap(Key::of(Channel::TerminalHeight), height, now);
			},
			None => return,
		}
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

	fn terminal_target(&self) -> f32 {
		if self.store.terminal.open {
			self.store.terminal.height
		} else {
			layout::TERMINAL_STRIP
		}
	}

	// ---- regions ----

	fn titlebar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Stateful<Div> {
		let theme = Theme::get(cx);
		let now = self.now;
		let client_side = matches!(window.window_decorations(), Decorations::Client { .. });
		let traffic_lights = cfg!(target_os = "macos");

		let session = self.store.selected_session();
		let title = session.map(|session| session.title.clone());
		let model = session.map(|session| session.model.clone());
		let branch = session.and_then(|session| session.branch.clone());
		let project = session
			.and_then(|session| self.store.project(&session.project))
			.map(|project| project.name.clone());
		let attention = self.store.attention();

		let mut bar = div()
			.id("titlebar")
			.flex()
			.items_center()
			.h(px(layout::TITLEBAR))
			.w_full()
			.pl(px(if traffic_lights { 76.0 } else { space::WIDE }))
			.pr(px(space::SNUG))
			.gap(px(space::BASE))
			.bg(theme.window)
			.on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
				// The window's own drag region. A double click is the platform's
				// zoom, which is what a titlebar does everywhere.
				if event.click_count > 1 {
					window.zoom_window();
				} else {
					window.start_window_move();
				}
			});

		// What the window is looking at. The project is the quiet half and the
		// session is the loud one, so the eye finds the session first.
		bar = bar.child(
			ui::line_of(space::SNUG)
				.min_w(px(0.0))
				.flex_1()
				.when_some(project, |element, project| {
					element.child(
						ui::line(project)
							.text_size(px(size::SMALL))
							.text_color(theme.text_faint)
							.flex_none(),
					)
				})
				.child(
					div()
						.text_size(px(size::SMALL))
						.text_color(theme.text_faint)
						.child("/")
						.flex_none(),
				)
				.child(
					ui::line(title.unwrap_or_else(|| "veyyon".to_owned()))
						.text_size(px(size::BODY))
						.font_weight(gpui::FontWeight::MEDIUM)
						.text_color(theme.text),
				)
				.when_some(branch, |element, branch| {
					element.child(ui::tag(branch, &theme).flex_none())
				}),
		);

		// The right shoulder: what wants attention, the model, and the ways in.
		let attention_chip = (attention > 0)
			.then(|| ui::chip(format!("{attention} waiting"), theme.warning, &theme).flex_none());

		bar = bar.child(
			ui::line_of(space::TIGHT)
				.flex_none()
				.children(attention_chip)
				.when_some(model, |element, model| {
					let wash = ui::wash(
						&mut self.motion,
						Key::named(Channel::Control, "model"),
						theme.sunken,
						theme.hover(),
						now,
					);
					element.child(
						div()
							.id("model")
							.flex()
							.items_center()
							.h(px(22.0))
							.px(px(space::BASE))
							.rounded(px(radius::CHIP))
							.bg(wash)
							.text_size(px(size::META))
							.text_color(theme.text_muted)
							.cursor_pointer()
							.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
							.on_hover(cx.listener(|shell, hovered: &bool, window, _| {
								let now = shell.stamp();
								shell.motion.flip(
									Key::named(Channel::Control, "model"),
									*hovered,
									motion::WASH,
									now,
								);
								window.refresh();
							}))
							.on_click(cx.listener(|shell, _, window, cx| {
								shell.show_palette(PaletteKind::Model, window, cx);
							}))
							.child(model),
					)
				})
				.child(self.titlebar_button(
					"new",
					ui::glyph::NEW,
					cx.listener(|shell, _, window, cx| {
						moves::new_session(&mut shell.store);
						shell.pull_draft(cx);
						Editor::focus(&shell.composer, window, cx);
						cx.notify();
					}),
					cx,
				))
				.child(self.titlebar_button(
					"settings",
					ui::glyph::SETTINGS,
					cx.listener(|shell, _, _, cx| {
						moves::run_action(&mut shell.store, "settings");
						cx.notify();
					}),
					cx,
				)),
		);

		// A window drawing its own frame draws its own caption buttons.
		if client_side && !traffic_lights {
			bar = bar.child(
				ui::line_of(space::HAIR)
					.flex_none()
					.ml(px(space::SNUG))
					.child(self.titlebar_button(
						"minimize",
						"\u{2013}",
						cx.listener(|_, _, window: &mut Window, _| window.minimize_window()),
						cx,
					))
					.child(self.titlebar_button(
						"maximize",
						"\u{25a1}",
						cx.listener(|_, _, window: &mut Window, _| window.zoom_window()),
						cx,
					))
					.child(self.titlebar_button(
						"close",
						ui::glyph::CLOSE,
						cx.listener(|_, _, window: &mut Window, _| window.remove_window()),
						cx,
					)),
			);
		}

		bar
	}

	/// One control in the titlebar: hover-washed, and not part of the drag
	/// region, because a button that moves the window is not a button.
	fn titlebar_button(
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
			.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
			.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
				let now = shell.stamp();
				shell.motion.flip(key, *hovered, motion::WASH, now);
				window.refresh();
			}))
			.on_click(click)
	}

	/// The bar along the bottom. Always present, never conditional: a strip that
	/// appears when something happens moves everything above it.
	fn status_strip(&mut self, cx: &mut Context<Self>) -> Div {
		let theme = Theme::get(cx);
		let working = self.store.working();
		let waiting = self.store.attention();
		let running_commands = self.store.terminal.running();
		let path = self
			.store
			.selected_session()
			.and_then(|session| self.store.project(&session.project))
			.map(|project| project.path.clone())
			.unwrap_or_default();
		let phase = if working > 0 || running_commands > 0 {
			Some(self.motion.phase(motion::SPIN_MS, self.now))
		} else {
			None
		};

		div()
			.flex()
			.items_center()
			.gap(px(space::WIDE))
			.h(px(layout::STATUS))
			.w_full()
			.px(px(space::WIDE))
			.bg(theme.window)
			.text_size(px(size::MICRO))
			.text_color(theme.text_faint)
			.child(ui::line(path).flex_1().min_w(px(0.0)))
			.children(phase.map(|phase| {
				let cells = 4;
				ui::line_of(2.0)
					.flex_none()
					.children((0..cells).map(|index| {
						div()
							.size(px(3.0))
							.rounded(px(1.5))
							.bg(theme.accent.opacity(motion::wave(phase, index, cells)))
					}))
			}))
			.when(working > 0, |element| {
				element.child(div().flex_none().child(format!("{working} working")))
			})
			.when(waiting > 0, |element| {
				element.child(
					div()
						.flex_none()
						.text_color(theme.warning)
						.child(format!("{waiting} waiting")),
				)
			})
			.when(running_commands > 0, |element| {
				element.child(
					div()
						.flex_none()
						.child(format!("{running_commands} running")),
				)
			})
			.child(
				div()
					.flex_none()
					.child(if self.store.settings.sidebar_open {
						format!("{} hide", keys::label("secondary-b"))
					} else {
						format!("{} show", keys::label("secondary-b"))
					}),
			)
			.child(
				div()
					.flex_none()
					.child(format!("{} commands", keys::label("secondary-k"))),
			)
	}

	/// The strip between two regions that resizes them.
	fn handle_v(&mut self, cx: &mut Context<Self>) -> Stateful<Div> {
		div()
			.id("sidebar-handle")
			.w(px(layout::HANDLE))
			.h_full()
			.flex_none()
			.cursor(CursorStyle::ResizeLeftRight)
			.on_mouse_down(
				MouseButton::Left,
				cx.listener(|shell, event: &MouseDownEvent, _, cx| {
					shell.begin_sidebar_drag(event, cx);
				}),
			)
	}

	fn handle_h(&mut self, cx: &mut Context<Self>) -> Stateful<Div> {
		div()
			.id("terminal-handle")
			.h(px(layout::HANDLE))
			.w_full()
			.flex_none()
			.cursor(CursorStyle::ResizeUpDown)
			.on_mouse_down(
				MouseButton::Left,
				cx.listener(|shell, event: &MouseDownEvent, _, cx| {
					shell.begin_terminal_drag(event, cx);
				}),
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
		let drag = self.drag?;
		Some(
			div()
				.absolute()
				.inset_0()
				.cursor(match drag {
					Drag::Sidebar { .. } => CursorStyle::ResizeLeftRight,
					Drag::Terminal { .. } => CursorStyle::ResizeUpDown,
				})
				.on_mouse_move(cx.listener(|shell, event: &MouseMoveEvent, window, cx| {
					shell.drag_move(event, window, cx);
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
		let terminal_height = self.motion.drive(
			Key::of(Channel::TerminalHeight),
			motion::RESIZE,
			self.terminal_target(),
			now,
		);

		self.settle_focus(window, cx);

		let titlebar = self.titlebar(window, cx);
		let sidebar = sidebar::render(self, cx);
		let main = match self.store.route {
			Route::Chat => transcript::render(self, cx).into_any_element(),
			Route::Settings(page) => settings::render(self, page, cx).into_any_element(),
		};
		let composer = matches!(self.store.route, Route::Chat)
			.then(|| composer::render(self, window, cx).into_any_element());
		let terminal_panel = terminal::render(self, cx);
		let status = self.status_strip(cx);
		let handle_v = self.handle_v(cx);
		let handle_h = self.handle_h(cx);
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
					.flex_none()
					.w(px(sidebar_width))
					.h_full()
					.overflow_hidden()
					.bg(theme.panel)
					.child(sidebar),
			)
			.child(handle_v)
			.child(
				div()
					.flex()
					.flex_col()
					.flex_1()
					.min_w(px(0.0))
					.h_full()
					.bg(theme.canvas)
					.child(
						div()
							.flex()
							.flex_col()
							.flex_1()
							.min_h(px(0.0))
							.overflow_hidden()
							.child(main),
					)
					.children(composer)
					.child(handle_h)
					.child(
						div()
							.flex()
							.flex_col()
							.flex_none()
							.h(px(terminal_height))
							.overflow_hidden()
							.bg(theme.panel)
							.child(terminal_panel),
					),
			);

		// The frame tail. Everything that moves has been read by now, so the
		// registry can retire what nobody looked at and say whether another
		// frame is owed.
		let motion_moved = self.motion.advance(now);
		let next_frame = self.motion.next_frame_after(now);
		let needs_frame = store_moved || motion_moved || self.store.animating();
		match next_frame {
			Some(0) => window.request_animation_frame(),
			Some(wait) => self.schedule(wait, cx),
			None if needs_frame => window.request_animation_frame(),
			None => {},
		}

		// The window's key context, and its focus target of last resort. A
		// focusable ancestor takes the keyboard on any click that lands in it,
		// which is every click on chrome: a sidebar row, a tab, the composer's
		// padding. `settle_focus` hands it straight back to the field the route
		// draws, and keeps it here only while the route draws none.
		div()
			.key_context("Shell")
			.track_focus(&self.focus)
			.relative()
			.size_full()
			.flex()
			.flex_col()
			.bg(theme.window)
			.text_color(theme.text)
			.text_size(px(size::BODY))
			.line_height(px(size::BODY * 1.55))
			.font_family(theme.font_ui)
			.when(matches!(window.window_decorations(), Decorations::Client { .. }), |element| {
				element.rounded(px(radius::SHEET)).overflow_hidden()
			})
			.on_action(cx.listener(Self::toggle_sidebar))
			.on_action(cx.listener(Self::toggle_terminal))
			.on_action(cx.listener(Self::new_session))
			.on_action(cx.listener(Self::open_palette))
			.on_action(cx.listener(Self::pick_model))
			.on_action(cx.listener(Self::pick_theme))
			.on_action(cx.listener(Self::open_settings))
			.on_action(cx.listener(Self::cycle_next))
			.on_action(cx.listener(Self::cycle_prev))
			.on_action(cx.listener(Self::interrupt))
			.on_action(cx.listener(Self::flip_appearance))
			.on_action(cx.listener(Self::cancel))
			.on_action(cx.listener(Self::palette_up))
			.on_action(cx.listener(Self::palette_down))
			.on_action(cx.listener(Self::palette_accept))
			.on_action(cx.listener(Self::focus_composer))
			.child(titlebar)
			.child(ui::hairline(&theme))
			.child(body)
			.child(ui::hairline(&theme))
			.child(status)
			.children(overlay)
			.children(drag_surface)
			.children(resize_edges)
	}
}

impl Shell {
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

/// A small convenience for reading two things out of an entity in one
/// expression, so a borrow does not have to be named.
trait Pipe {
	fn pipe<R>(&self, f: impl FnOnce(&Self) -> R) -> R {
		f(self)
	}
}

impl<T> Pipe for T {}
