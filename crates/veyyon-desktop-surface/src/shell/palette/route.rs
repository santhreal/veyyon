//! Moving between the surfaces the palette draws (§5.8).
//!
//! A row descends into another surface, `Escape` returns to the one it was
//! reached from, and the root closes. The path back is the surfaces the
//! operator actually visited, which is not the route table's parent: a surface
//! opened directly has nothing above it.

use veyyon_gpui::Context;

use crate::{Intent, Overlay, PaletteState, ShellView, navigation::SurfaceRoute};

impl ShellView {
	/// The surface an ascent returns to: the one the operator descended from,
	/// not the route table's parent. A surface reached directly -- the rail
	/// footer gear, a slash command, a keybinding -- has nothing above it, so
	/// this is `None` there and `Escape` closes instead of opening a palette
	/// that was never visited (§5.8).
	#[must_use]
	pub fn back_route(&self) -> Option<SurfaceRoute> {
		self
			.palette_input
			.parents
			.last()
			.and_then(PaletteState::route)
	}

	/// Replaces the visible route without closing or restarting its float
	/// motion.
	pub fn navigate_surface(&mut self, route: SurfaceRoute, cx: &mut Context<Self>) {
		self.dispatch(Intent::PreviewAppearance(None), cx);
		let returning = self.back_route() == Some(route);
		let restored = if returning {
			self.palette_input.parents.pop()
		} else {
			if let Some(parent) = self.state.overlay.as_ref().and_then(Overlay::as_palette)
				&& parent.route() != Some(route)
			{
				self.palette_input.parents.push(parent.clone());
			}
			None
		};
		self.palette_input.slash = false;
		self.palette_input.anchored = false;
		self.palette_input.restore_focus = false;
		self.dispatch(Intent::Navigate(route), cx);
		if let Some(parent) = restored {
			self.state.overlay = Some(Overlay::Palette(parent));
		}
		self.palette_input.focus_search = true;
		if self.state.overlay.as_ref().is_some_and(Overlay::is_palette) {
			let editor = self.ensure_palette_editor(cx);
			let query = self
				.state
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.map_or_else(String::new, |palette| palette.query().to_owned());
			editor.update(cx, |editor, cx| editor.set_text(query, cx));
			self.palette_input.focus_search = true;
		}
		cx.notify();
	}

	/// Ascends the command hierarchy, or one browsed directory, before closing
	/// its root (§5.8).
	pub fn back_surface(&mut self, cx: &mut Context<Self>) {
		if let Some(parent) = self
			.state
			.overlay
			.as_ref()
			.and_then(Overlay::as_palette)
			.and_then(PaletteState::browse_parent)
		{
			self.dispatch(Intent::BrowseTo { path: parent }, cx);
			cx.notify();
			return;
		}
		match self.back_route() {
			Some(parent) => self.navigate_surface(parent, cx),
			None => self.close_palette(cx),
		}
		cx.notify();
	}

	/// Closes the menu without discarding the draft and restores focus on the
	/// next frame.
	pub fn close_palette(&mut self, cx: &mut Context<Self>) {
		if self.palette_input.slash {
			self.palette_input.dismissed = Some(self.composer_cache.clone());
		}
		self.palette_input.slash = false;
		self.dispatch(Intent::PreviewAppearance(None), cx);
		self.palette_input.restore_focus = true;
		self.palette_input.parents.clear();
		self.dispatch(Intent::CloseOverlay, cx);
	}
}
