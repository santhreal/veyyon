//! The entry tree a session's tree sheet draws.

use veyyon_desktop_model::{
	EntryId, SessionId, SnapshotSection,
	domain::{SessionTreeEntryKind, SessionTreeFilter, SessionTreeNode, SessionTreeView},
};

/// A prompt and its reply, with the session continuing from `leaf` and the
/// prompt labelled `label` when one is given.
pub fn session_tree(session: &str, leaf: &str, label: Option<&str>) -> SnapshotSection {
	let row = |id: &str, parent: Option<&str>, kind, prefix: &str, text: &str| SessionTreeNode {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		depth: 0,
		kind,
		prefix: prefix.into(),
		text: text.into(),
		label: None,
		on_path: true,
		shown_in: vec![SessionTreeFilter::Default, SessionTreeFilter::All],
	};
	let mut prompt = row("e1", None, SessionTreeEntryKind::User, "user: ", "fix the build");
	prompt.label = label.map(Into::into);
	let reply = row("e2", Some("e1"), SessionTreeEntryKind::Assistant, "assistant: ", "Fixed.");
	SnapshotSection::SessionTree {
		session: SessionId::from(session),
		tree:    SessionTreeView {
			leaf:            Some(EntryId::from(leaf)),
			nodes:           vec![prompt, reply],
			summary_offered: false,
			filter:          SessionTreeFilter::Default,
		},
	}
}
