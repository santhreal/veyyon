//! The window's own frame: two headers, the window controls, the drag handle
//! and the resize edges.
//!
//! Everything here is about the window rather than about what is in it, which
//! is why it is the one part of the app crate that draws. A surface in the
//! feature crate is a function of the store; a header is a function of the
//! window: what the platform draws for us, whether the frame is ours to round
//! off, and where a drag starts.
//!
//! TWO HEADERS, NOT ONE TITLEBAR. Each column carries its own, so the chrome
//! colour stops at the sidebar's edge and the content column keeps its top
//! corner. Both drag the window and both zoom on a double click, so the band
//! across the top behaves as one titlebar to a hand while being two to the eye.

use gpui::{
	App, Context, CursorStyle, Decorations, Div, Hsla, InteractiveElement, MouseButton,
	MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, ResizeEdge, Stateful,
	StatefulInteractiveElement, Styled, Window, div, hsla, px,
};
use veyyon_gui_core::{command::Command, store::model::Route};
use veyyon_gui_features::act;
use veyyon_gui_kit::{
	motion::{Channel, Key},
	paint,
	theme::{Theme, layout, radius, size, space},
	ui::{Badge, Button, Fill, Icon, Size, Tone, text},
};

use crate::shell::Shell;

/// Whether the app draws its own frame, and may therefore round it off.
pub fn owns_its_frame(window: &Window) -> bool {
	matches!(window.window_decorations(), Decorations::Client { .. })
}

/// A header, at the top of either column. Drags the window, zooms on a double
/// click, and carries whatever the column puts in it.
fn header(id: &'static str) -> Stateful<Div> {
	div()
		.id(id)
		.flex()
		.items_center()
		.flex_none()
		.h(px(layout::TITLEBAR))
		.w_full()
		.gap(px(space::SNUG))
		.on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
			if event.click_count > 1 {
				window.zoom_window();
			} else {
				window.start_window_move();
			}
		})
}

/// The sidebar column's header: the window controls and the two ways into the
/// list under it.
///
/// The toggle that hides this column is not here. It is in the other header,
/// where it stays in one place whether the column is open or shut: a control
/// that moves across the window when it is pressed has to be found again.
pub fn sidebar_header(
	shell: &mut Shell,
	window: &Window,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let controls = shell
		.store
		.settings
		.sidebar_open
		.then(|| window_controls(window, cx))
		.flatten();
	header("sidebar-header")
		.pl(px(space::WIDE))
		.pr(px(space::BASE))
		.children(controls)
		.child(text::spacer())
		.child(
			Button::new("search-conversations", Icon::Search)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.tip("Search conversations and commands")
				.keys("secondary-k")
				.on_click(act::click(Command::OpenPalette)),
		)
		.child(
			Button::new("new-conversation", Icon::New)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.tip("Start a conversation")
				.keys("secondary-n")
				.on_click(act::click(Command::NewSession)),
		)
}

/// The content column's header: what is on screen, and what it is attached to.
///
/// One line, which is the name of what is under it. A second line counting the
/// messages restates what the reader is looking at, and the name is already in
/// the list to the left: a third copy is what makes a window feel repetitive.
pub fn content_header(
	shell: &mut Shell,
	window: &Window,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let store = &shell.store;
	let sidebar_open = store.settings.sidebar_open;
	let controls = (!sidebar_open)
		.then(|| window_controls(window, cx))
		.flatten();
	let in_settings = matches!(store.route, Route::Settings(_));

	let title = match store.route {
		Route::Chat => store
			.selected_session()
			.map(|session| session.title.clone())
			.unwrap_or_default(),
		Route::Settings(page) => page.label().to_owned(),
	};

	header("content-header")
		.px(px(space::WIDE))
		.border_b_1()
		.border_color(theme.stroke)
		.children(controls)
		// The one control that is in the same place whichever state the window
		// is in, because it is the control that changes that state.
		.child(
			Button::new("toggle-sidebar", Icon::Panel)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.tip(if sidebar_open {
					"Hide the conversation list"
				} else {
					"Show the conversation list"
				})
				.keys("secondary-b")
				.on_click(act::click(Command::ToggleSidebar)),
		)
		// The list's own header holds this while the column is open, so it
		// appears here only when that header is not on screen.
		.children((!sidebar_open && !in_settings).then(|| {
			Button::new("new-conversation-alone", Icon::New)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.tip("Start a conversation")
				.keys("secondary-n")
				.on_click(act::click(Command::NewSession))
		}))
		.child(
			text::line(title)
				.flex_1()
				.min_w(px(0.0))
				.text_size(px(size::BODY))
				.font_weight(veyyon_gui_kit::theme::weight::MEDIUM)
				.line_height(px(size::BODY * size::LINE_TIGHT))
				.text_color(theme.text),
		)
		// What the window is attached to, said once, where a reader looks for the
		// state of the thing they are talking to. Not a control: there is nothing
		// to attach to yet, and a button that cannot do anything is worse than a
		// line that says so.
		.children((!in_settings).then(|| {
			Badge::new(shell.store.engine.what())
				.icon(Icon::Engine)
				.tone(if shell.store.engine.is_attached() {
					Tone::Ok
				} else {
					Tone::Muted
				})
				.size(Size::Small)
				.bare()
		}))
		.children(in_settings.then(|| {
			Button::new("leave-settings", Icon::Close)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.tip("Back to the conversation")
				.keys("escape")
				.on_click(act::click(Command::CloseSettings))
		}))
}

/// The three circles that close, minimize and zoom the window.
///
/// macOS draws its own into the frameless titlebar, so this is the same set for
/// the platforms where the app owns its frame. They are the platform's order
/// and the platform's colours; a window with no border needs them to be
/// findable without hunting.
fn window_controls(window: &Window, cx: &mut App) -> Option<Div> {
	if cfg!(target_os = "macos") || !owns_its_frame(window) {
		return None;
	}
	let theme = Theme::get(cx);
	Some(
		text::line_of(space::BASE)
			.flex_none()
			.child(control("win-close", theme.danger, |window| window.remove_window(), cx))
			.child(control(
				"win-minimize",
				hsla(0.13, 0.85, 0.60, 1.0),
				|window| window.minimize_window(),
				cx,
			))
			.child(control(
				"win-zoom",
				hsla(0.33, 0.55, 0.52, 1.0),
				|window| window.zoom_window(),
				cx,
			)),
	)
}

/// One of them. Dim until the pointer is on the row of three, which is what
/// every window on the machine does with them.
fn control(id: &'static str, color: Hsla, action: fn(&mut Window), cx: &mut App) -> Stateful<Div> {
	let key = Key::named(Channel::Control, id);
	div()
		.id(id)
		.size(px(layout::CONTROL))
		.rounded(px(radius::PILL))
		.bg(paint::wash(cx, key, color.opacity(0.55), color))
		.cursor_pointer()
		.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
		.on_hover(move |over, _window, cx| {
			paint::hover(cx, key, *over);
			cx.refresh_windows();
		})
		.on_click(move |_, window: &mut Window, _| action(window))
}

/// The strip between the two columns that resizes them.
pub fn handle(cx: &mut Context<Shell>) -> Stateful<Div> {
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

/// While a drag is live, one surface over the whole window takes every pointer
/// event.
///
/// The alternative is a global mouse listener, which then has to work out
/// whether it is the one that should care. A drag is modal by nature, so
/// drawing it as a modal surface is both simpler and correct at the edges: the
/// pointer leaving the handle, leaving the window, or landing on a row that
/// would otherwise light up under it.
pub fn drag_surface(shell: &Shell, cx: &mut Context<Shell>) -> Option<Div> {
	shell.drag?;
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
pub fn resize_edges(window: &Window) -> Option<Div> {
	if !owns_its_frame(window) {
		return None;
	}
	let edge = |id: &'static str, edge: ResizeEdge| {
		div()
			.id(id)
			.absolute()
			.on_mouse_down(MouseButton::Left, move |_, window: &mut Window, cx| {
				window.start_window_resize(edge);
				cx.stop_propagation();
			})
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
