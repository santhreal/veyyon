//! The thread column: header and transcript, then the composer lane's dock
//! and composer.
//!
//! `ThreadView` is a cheap shell. Its children are entities of their own,
//! embedded cached. The streaming reply is the transcript list's last item,
//! so a reply taller than the thread scrolls with the list; a streamed delta
//! notifies the tail, which dirties the transcript and this shell, and the
//! header reuses its last frame. The dock and the composer are laid out at
//! the height they last drew at, and the shell renders when one moves. The
//! freeze of every agent is the host's, not the thread's, so the workspace
//! draws its strip above the column. While the session tree is open it
//! takes the transcript's place.

pub mod header;
mod slot;
mod status;
pub mod tree;

use gpui::{
	Context, Entity, Pixels, Render, StyleRefinement, Subscription, Window, div, prelude::*,
};
use veyyon_desktop_ui::theme::{ActiveTheme, size};

pub use self::slot::init;
use self::{header::ThreadHeader, slot::Slot};
use crate::{
	AppState,
	composer::{Composer, Resized, route},
	dock::InteractionDock,
	transcript::Transcript,
};

/// The thread region.
pub struct ThreadView {
	app:            Entity<AppState>,
	header:         Entity<ThreadHeader>,
	transcript:     Entity<Transcript>,
	dock:           Entity<InteractionDock>,
	composer:       Entity<Composer>,
	/// The session tree, while it is open.
	tree:           Option<Slot>,
	/// The heights the dock and the composer last drew at.
	heights:        (Pixels, Pixels),
	_subscriptions: [Subscription; 3],
}

impl ThreadView {
	/// Creates the thread column over `app`.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		route::register(window, &cx.entity(), cx);
		let header = cx.new(|cx| ThreadHeader::new(app.clone(), window, cx));
		let transcript = cx.new(|cx| Transcript::new(app.clone(), window, cx));
		let dock = cx.new(|cx| InteractionDock::new(app.clone(), window, cx));
		let composer = cx.new(|cx| Composer::new(app.clone(), window, cx));
		let docked = cx.subscribe(&dock, |this, _, event: &Resized, cx| {
			this.resize((event.0, this.heights.1), cx);
		});
		let composed = cx.subscribe(&composer, |this, _, event: &Resized, cx| {
			this.resize((this.heights.0, event.0), cx);
		});
		let store = cx.subscribe(&app, Self::on_store_event);
		let heights = (dock.read(cx).height(), composer.read(cx).height());
		Self {
			app,
			header,
			transcript,
			dock,
			composer,
			tree: None,
			heights,
			_subscriptions: [docked, composed, store],
		}
	}

	/// Lays the dock and the composer out at `heights` from the next frame.
	fn resize(&mut self, heights: (Pixels, Pixels), cx: &mut Context<Self>) {
		if heights != self.heights {
			self.heights = heights;
			cx.notify();
		}
	}

	/// The interaction dock entity.
	#[must_use]
	pub const fn dock(&self) -> &Entity<InteractionDock> {
		&self.dock
	}

	/// The composer entity.
	#[must_use]
	pub const fn composer(&self) -> &Entity<Composer> {
		&self.composer
	}

	/// The transcript entity.
	#[must_use]
	pub const fn transcript(&self) -> &Entity<Transcript> {
		&self.transcript
	}
}

impl Render for ThreadView {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		div()
			.size_full()
			.flex()
			.flex_col()
			.bg(palette.bg.app)
			.child(
				div().w_full().flex_shrink_0().child(
					self
						.header
						.clone()
						.cached(StyleRefinement::default().w_full().h(size::HEADER)),
				),
			)
			.child(
				div()
					.flex_1()
					.min_h_0()
					.w_full()
					.child(self.transcript_slot()),
			)
			.child(
				self.dock.clone().cached(
					StyleRefinement::default()
						.w_full()
						.flex_none()
						.h(self.heights.0),
				),
			)
			.child(
				self.composer.clone().cached(
					StyleRefinement::default()
						.w_full()
						.flex_none()
						.h(self.heights.1),
				),
			)
	}
}
