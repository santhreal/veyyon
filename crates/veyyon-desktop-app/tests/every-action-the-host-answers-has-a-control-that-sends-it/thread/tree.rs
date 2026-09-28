//! The session tree: the header button that opens it and asks for the tree,
//! and on its rows Enter that goes to one, Escape that stops the summary a
//! move writes, and Shift-L that labels one.

use veyyon_desktop_model::SnapshotSectionKind;

use crate::harness::{Win, corpus};

/// Opens the tree over the tree the host answers: the prompt `e1` and the
/// leaf `e4` shown, the keyboard on the leaf, and a summary of the branch
/// left offered.
fn answered(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::SessionTree)]);
}

pub(super) fn open(w: &mut Win<'_>) {
	w.click("thread.tree");
}

/// Goes up to the prompt and takes it without a summary, the first choice.
pub(super) fn navigate(w: &mut Win<'_>) {
	w.keys("secondary-shift-t");
	answered(w);
	w.keys("up enter enter");
}

/// Goes up to the prompt with a summary, the second choice, and stops the
/// summary while the host writes it.
pub(super) fn stop_summary(w: &mut Win<'_>) {
	w.palette("Show the session tree");
	answered(w);
	w.keys("up enter down enter");
	w.keys("escape");
}

/// Labels the leaf.
pub(super) fn label(w: &mut Win<'_>) {
	w.keys("secondary-shift-t");
	answered(w);
	w.keys("shift-l");
	w.typed("checkpoint");
	w.keys("enter");
}
