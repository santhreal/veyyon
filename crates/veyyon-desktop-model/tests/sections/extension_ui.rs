//! The extension chrome and completion sections, which replace what a session
//! held.

use veyyon_desktop_model::{
	SnapshotSection,
	domain::{
		ComposerCompletionView, ComposerCompletionsView, ExtensionStatusView, ExtensionUiView,
		ExtensionWidgetPlacement, ExtensionWidgetView,
	},
};

/// One status entry and one widget stating `text`.
pub fn extension_ui(session: &str, text: &str) -> SnapshotSection {
	SnapshotSection::ExtensionUi {
		session: session.into(),
		ui:      ExtensionUiView {
			statuses:        vec![ExtensionStatusView { key: "lint".into(), text: text.into() }],
			working_message: Some("Indexing".into()),
			widgets:         vec![ExtensionWidgetView {
				key:       "todo".into(),
				placement: ExtensionWidgetPlacement::AboveEditor,
				lines:     vec![text.into()],
				truncated: false,
			}],
			completes:       true,
		},
	}
}

/// One completion replacing the two bytes before the caret at 6.
pub fn completions(session: &str, query: u64, label: &str) -> SnapshotSection {
	SnapshotSection::ComposerCompletions {
		session:     session.into(),
		completions: ComposerCompletionsView {
			query,
			items: vec![ComposerCompletionView {
				label:         label.into(),
				description:   None,
				replace_start: 4,
				replace_end:   6,
				insert:        label.into(),
				caret:         4 + u32::try_from(label.len()).unwrap_or(u32::MAX),
			}],
		},
	}
}
