//! Shift-L opens a field holding the label of the row the keyboard is on.
//! Enter sends the label trimmed, `None` for an empty one, and nothing when
//! it matches the entry's; Escape leaves it unsent. A refused label is stated
//! in the host's words.

use gpui::TestAppContext;

use super::harness::{Win, branched, browsing, label, refused};

/// The field's heading.
const FIELD: &str = "Label for this entry";

impl Win<'_> {
	/// Opens the label field on the row the keyboard is on, replaces what it
	/// holds with `text` and presses Enter.
	fn relabel(&mut self, text: &str) {
		self.keys("shift-l");
		assert!(self.draws(FIELD), "Shift-L opens the label field: {:?}", self.texts());
		self.keys("ctrl-a backspace");
		self.write(text);
		self.keys("enter");
		assert!(self.draws("try the other branch"), "Enter returns to the rows");
	}
}

#[gpui::test]
fn a_label_is_sent_trimmed_cleared_when_empty_and_not_when_unchanged(app: &mut TestAppContext) {
	// Default shows u1 a1 t1 u2 a2 b1 b2; the leaf is a2 and b1 holds
	// `stale-idea`.
	let mut w = browsing(app, branched(false));
	w.keys("down");
	assert_eq!(w.selected().as_deref(), Some("b1"));
	w.keys("shift-l");
	assert!(w.draws("stale-idea"), "the field holds the entry's label");
	w.keys("enter");
	assert!(w.sent().is_empty(), "the label unchanged is not sent");

	w.relabel("  fresh  ");
	assert_eq!(w.sent(), [label("b1", Some("fresh"))], "a label is sent trimmed");
	w.relabel("  stale-idea ");
	assert!(w.sent().is_empty(), "a label that trims to the entry's is not sent");
	w.relabel("   ");
	assert_eq!(w.sent(), [label("b1", None)], "an empty label clears the entry's");

	w.keys("up");
	assert_eq!(w.selected().as_deref(), Some("a2"));
	w.relabel(" ");
	assert!(w.sent().is_empty(), "an empty label on an unlabeled entry is not sent");
	w.relabel("checkpoint");
	assert_eq!(w.sent(), [label("a2", Some("checkpoint"))]);
}

#[gpui::test]
fn escape_leaves_the_label_unsent(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	w.keys("shift-l");
	w.write("never sent");
	w.keys("escape");
	assert!(w.sent().is_empty(), "Escape sends nothing");
	assert!(w.draws("parser done"), "and returns to the rows");
	assert_eq!(w.closed(), 0, "without closing the sheet");
	w.keys("shift-l");
	assert!(!w.draws("never sent"), "the next field holds the entry's label, not the text left");
}

#[gpui::test]
fn a_refused_label_is_stated_in_the_hosts_words(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	w.relabel("checkpoint");
	let request = w.one();
	assert_eq!(request.action, label("a2", Some("checkpoint")));
	w.apply(vec![refused(request.id, "The session file is read-only")]);
	assert!(w.draws("The session file is read-only"), "{:?}", w.texts());
	assert_eq!(w.closed(), 0);
}
