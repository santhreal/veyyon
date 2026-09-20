//! Queue partition toggles and topmost-surface dismissal.

use veyyon_gpui::{Context, Window};

use crate::{Intent, Overlay, Section, ShellView};

/// The intent a partition chord dispatches for the session the rail has
/// selected.
///
/// `P`, `D` and `K` are toggles (§5.14): a session already in the partition
/// the chord names comes back out to `Live`, and one anywhere else moves in.
/// The comparison is against the row's placement, not the section it is drawn
/// in, because a row holding a draft draws under `Unsent`, which is no
/// partition to come back out of. Returns `None` when no session is selected,
/// and for a partition no chord names, since there is nothing to move.
///
/// The subject is the cursor, not the open session: the arrows move the cursor
/// without opening, so a chord acts on the row the operator is looking at.
pub(super) fn partition_toggle(view: &ShellView, into: Section) -> Option<Intent> {
	let current = view.state().selected_row();
	if current == 0 {
		return None;
	}
	let held = view.state().row(current).map(|row| row.placement) == Some(into);
	match (into, held) {
		(Section::Pinned, false) => Some(Intent::PinSession(current)),
		(Section::Pinned, true) => Some(Intent::UnpinSession(current)),
		(Section::Deferred, false) => Some(Intent::DeferSession(current)),
		(Section::Deferred, true) => Some(Intent::RecallSession(current)),
		(Section::Parked, false) => Some(Intent::ParkSession(current)),
		(Section::Parked, true) => Some(Intent::UnparkSession(current)),
		(Section::Unsent | Section::Live, _) => None,
	}
}

/// The fold the arrow keys ask for on the row the rail has selected.
///
/// Left folds and right unfolds, which is what a tree answers arrows with.
/// The write is a toggle, so a press asking for the state the branch is
/// already in raises nothing: left on a folded branch is not a second fold.
/// A row with no children is never a subject either, since folding it would
/// hide no row and leave a chevron-less row drawn as folded.
pub(super) fn branch_fold(view: &ShellView, folded: bool) -> Option<Intent> {
	let current = view.state().selected_row();
	let row = view.state().row(current)?;
	(row.is_parent && row.collapsed != folded).then(|| Intent::ToggleQueueParent(row.path.clone()))
}

/// Dismisses the topmost thing over the transcript, one rung per press.
///
/// An anchored detail closes first, then a menu floated at the pointer, then
/// a routed overlay steps back one surface, an unrouted one closes, and a
/// queue floated over the transcript at a narrow width closes last, since it
/// is the only rung that is not an overlay in `state.overlay`. Nothing over
/// the transcript propagates, so the editor below keeps its own Escape.
pub(super) fn dismiss_topmost(
	view: &mut ShellView,
	window: &mut Window,
	cx: &mut Context<ShellView>,
) {
	if view.review_is_open() {
		view.close_review(window, cx);
		cx.stop_propagation();
		return;
	}
	// A detail popover is anchored to a control a menu may also be open over,
	// and it is drawn over the menu, so it is the rung above it. It also holds
	// the window's focus, which this press gives back.
	if view.detail().is_some() {
		view.close_detail(window, cx);
		cx.stop_propagation();
		cx.notify();
		return;
	}
	// The bar's open menu is floated on the same terms, and holds the
	// keyboard while it is up, so it is one rung of its own: a press closes
	// the menu and leaves what is under it where it was.
	if view.close_menu(window, cx) {
		cx.stop_propagation();
		return;
	}
	// A menu is floated over every other rung, including a routed overlay, so
	// it is the rung Escape takes next and alone: dismissing the surface under
	// an open menu would take two rungs on one press.
	if view.signal_menu().is_some() || view.turn_menu().is_some() || view.row_menu().is_some() {
		view.dismiss_picker_menu(window, cx);
		cx.stop_propagation();
		cx.notify();
		return;
	}
	// A narrowed settings page is a rung of its own: the press that finds a
	// query widens the page it narrowed, and the next one leaves the page. A
	// press that closed the page over a query would discard what the operator
	// can still see, and leave no way back to the rows it hid.
	if view.settings_query_is_narrowing() {
		view.clear_settings_query(cx);
		cx.stop_propagation();
		cx.notify();
		return;
	}
	let routed = view
		.state()
		.overlay
		.as_ref()
		.and_then(Overlay::route)
		.is_some();
	if routed {
		view.back_surface(cx);
	} else if view.state().overlay.is_some() {
		view.close_palette(cx);
	} else if !view.close_queue_float() {
		// A selection is the last rung: it covers nothing the reader has to get
		// out from under, so every surface over the transcript is dismissed
		// first, and the press that finds nothing else open drops the
		// highlight.
		if view.text_selection().is_none() {
			cx.propagate();
			return;
		}
		view.clear_text_selection();
	}
	cx.stop_propagation();
	cx.notify();
}
