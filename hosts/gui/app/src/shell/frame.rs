//! One frame: the instant, the two columns, and whether to ask for another.

use super::*;

impl Focusable for Shell {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for Shell {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		// One instant for the whole frame, sampled here and read by everything
		// below through the paint globals.
		self.now = paint::begin(cx.reduce_motion(), cx);
		let now = self.now;
		self.store.now_ms = now;
		let store_moved = moves::tick(&mut self.store, now);

		let theme = Theme::get(cx);
		let width =
			paint::toward(cx, Key::of(Channel::SidebarWidth), motion::RESIZE, self.sidebar_target());

		self.settle_focus(window, cx);

		let sidebar_header = chrome::sidebar_header(self, window, cx);
		let sidebar = sidebar::render(&self.store, cx);
		let content_header = chrome::content_header(self, window, cx);
		let main = match self.store.route {
			Route::Chat => transcript::render(&self.store, &self.transcript, cx),
			Route::Settings(page) => {
				settings::render(&self.store, page, &self.page, cx).into_any_element()
			},
		};
		let bar = match self.store.route {
			Route::Chat => scrollbar::Scrollbar::new("transcript-bar", self.transcript.clone()),
			Route::Settings(_) => scrollbar::Scrollbar::new("page-bar", self.page.clone()),
		};
		let composer = matches!(self.store.route, Route::Chat)
			.then(|| composer::render(&self.store, &self.composer, window, cx));
		let overlay = palette::render(&self.store, &self.search, cx);

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
					.w(px(width))
					.h_full()
					.overflow_hidden()
					.child(sidebar_header)
					.child(sidebar),
			)
			.child(chrome::handle(self, cx))
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
							.relative()
							.flex()
							.flex_col()
							.flex_1()
							.min_h(px(0.0))
							.overflow_hidden()
							.child(main)
							.child(bar),
					)
					.children(composer),
			);

		// The frame tail. Everything that moves has been read by now, so the
		// registry can retire what nobody looked at and ask for another frame if
		// anything is still going. The notice is the one thing in the store with
		// a deadline of its own, so it is folded in here.
		paint::end(window, cx);
		if store_moved {
			match self.store.deadline() {
				Some(until) => self.schedule(until.saturating_sub(now) as u32, cx),
				None => window.request_animation_frame(),
			}
		}

		// The window's key context, and its focus target of last resort. A
		// focusable ancestor takes the keyboard on any click that lands in it,
		// which is every click on chrome: a sidebar row, the composer's padding.
		// `settle_focus` hands it straight back to the field the route draws, and
		// keeps it here only while the route draws none.
		let frame = div()
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
			.when(chrome::owns_its_frame(window), |element| {
				element.rounded(px(radius::SHEET)).overflow_hidden()
			})
			.on_action(cx.listener(Self::act))
			.child(body)
			.children(overlay)
			.children(chrome::drag_surface(self, cx))
			.children(chrome::resize_edges(window));

		// A scrollbar thumb held down keeps following the pointer once it leaves
		// the thumb, which is every drag of more than a few pixels.
		scrollbar::while_dragging(frame, cx)
	}
}
