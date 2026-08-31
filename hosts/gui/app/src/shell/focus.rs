//! Where the keyboard is, for every surface the window can be showing.

use gpui::{Context, Window};
use veyyon_gui_core::{
	model::AuthFlowState,
	navigation::{Overlay, Route},
	store::FocusTarget,
};
use veyyon_gui_kit::input::Editor;

use super::Shell;

/// The state the keyboard's placement is a function of: the route drawing the
/// surfaces, and the overlays drawn over them.
///
/// Held so a placement happens when this changes and at no other time. A
/// reader who puts the keyboard in a filter or a secret field keeps it there,
/// because nothing they typed changed either of these.
#[derive(Default, PartialEq)]
pub struct KeyboardState {
	route:    Route,
	overlays: Vec<Overlay>,
}

impl Shell {
	/// Put the keyboard on the field the current route and overlay stack draw.
	///
	/// Derived from state and never from the command that ran, because a
	/// command is not where the surfaces are decided. Accepting one palette row
	/// runs a whole sequence inside the store; a field's own event reaches this
	/// window with no window to place focus with, so its effects arrive a frame
	/// later; a completed request drops the approval it answered. None of those
	/// arrives here as the `CloseTopOverlay` that did it, and each one takes a
	/// drawn field out of the tree. A binding dispatches from the focused
	/// element upward, so the window answers nothing at all — not even a chord
	/// bound everywhere — for as long as the keyboard sits on a field that left.
	///
	/// Nothing remembered is ever focused, which is what keeps this closed
	/// rather than nearly closed: a handle that held the keyboard a moment ago
	/// is exactly the handle most likely to be gone, whether its overlay
	/// closed, its route was replaced or its panel collapsed under it. The
	/// holder is recomputed instead, so it is drawn by construction.
	pub(super) fn reconcile_the_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let route = self.store.frontend.route;
		let overlays = &self.store.frontend.overlays;
		// Compared before anything is cloned: a frame that changed neither
		// leaves without allocating, which is every frame but the one after a
		// transition.
		if self.keyboard.route == route && &self.keyboard.overlays == overlays {
			return;
		}
		self.keyboard = KeyboardState { route, overlays: overlays.clone() };
		match overlays.last().and_then(Overlay::keyboard) {
			Some(target) => self.take_the_keyboard(target, window, cx),
			// Either nothing is over the route, or what is over it draws no
			// field of its own and leaves the route's own field reachable
			// underneath.
			None => self.take_the_keyboard(self.route_field(), window, cx),
		}
	}

	/// The field a route draws for text. Every other route's workspace is a
	/// list or a tree, and the frame carries the bindings those walk with.
	fn route_field(&self) -> FocusTarget {
		match self.store.frontend.route {
			Route::Conversation => FocusTarget::Composer,
			_ => FocusTarget::Shell,
		}
	}

	/// Hand the keyboard to the surface a focus target names.
	pub(super) fn take_the_keyboard(
		&mut self,
		target: FocusTarget,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let editors = &self.handles.editors;
		match target {
			FocusTarget::Composer => Editor::focus(&editors.composer, window, cx),
			FocusTarget::Palette => {
				// Seeded from the query the store holds, so the field a palette
				// opens with is the filter its rows were selected by. One editor
				// backs every palette-shaped overlay, so without this the text
				// of the last palette stays in the field of the next one while
				// its results come from an empty query.
				let query = self.store.frontend.palette_query.clone();
				let command = editors.command.clone();
				command.update(cx, |editor, cx| editor.set_text(&query, query.len(), cx));
				Editor::focus(&command, window, cx);
			},
			FocusTarget::Interaction => Editor::focus(&editors.interaction, window, cx),
			FocusTarget::RenameField => {
				// Seeded here rather than by whoever opened the sheet, so a
				// rename reached from a palette row starts on the current name
				// like a rename reached from the row's own button does.
				if let Some(Overlay::RenameSession { value, .. }) =
					self.store.frontend.overlays.last().cloned()
				{
					let rename = editors.rename_session.clone();
					rename.update(cx, |editor, cx| editor.set_text(&value, value.len(), cx));
					Editor::focus(&rename, window, cx);
				}
			},
			// No element tracks a handle for a terminal or the bottom dock, and
			// focusing one nothing draws would leave the window answering
			// nothing: the keyboard parks on the frame until a dock surface
			// tracks a handle of its own.
			FocusTarget::Terminal(_) | FocusTarget::Shell => {
				window.focus(&self.handles.focus.shell, cx)
			},
		}
	}

	/// The credential field is drawn only while a sign-in flow awaits a secret,
	/// so it takes the keyboard when that phase arrives rather than when the
	/// overlay opens: the phase comes on a host event, and focusing a field
	/// nothing draws is what leaves a window answering nothing at all. The
	/// placement above leaves it alone, because a phase changes neither the
	/// route nor the overlay stack.
	pub(super) fn place_the_credential_field(
		&mut self,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let open = matches!(self.store.frontend.overlays.last(), Some(Overlay::ProviderAuth { .. }));
		let awaiting =
			self.store.replica.auth.readable().is_some_and(|auth| {
				matches!(auth.value.flow, Some(AuthFlowState::AwaitingSecretInput))
			});
		if open && awaiting {
			Editor::focus(&self.handles.editors.provider_secret, window, cx);
		}
	}
}
