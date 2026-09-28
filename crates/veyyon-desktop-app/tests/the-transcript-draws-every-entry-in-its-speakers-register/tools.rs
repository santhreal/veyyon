//! A tool result no call row shows keeps its failure.
//!
//! WHY: a result whose call is not on the branch (the host sent the result
//! and not the call, or the call paged out) draws as a pane captioned with
//! the tool's name, and that caption dropped `is_error`: a failed run read
//! as a successful one.
//!
//! Gap: a result matched to its call is drawn by the call's row and its
//! status, which this does not read.

use gpui::TestAppContext;
use veyyon_desktop_app::transcript::plan::Piece;
use veyyon_desktop_model::{ContentBlock, MessageRole};

use super::{chain, opened, text, thread};

#[gpui::test]
fn a_result_with_no_call_row_states_whether_it_failed(cx: &mut TestAppContext) {
	for (is_error, caption) in [(false, "bash"), (true, "bash · error")] {
		let result = ContentBlock::ToolResult {
			tool: "bash".to_owned(),
			content: serde_json::json!("exit 2"),
			is_error,
			presentation: None,
		};
		let entries = chain(vec![
			("u", MessageRole::User, vec![text("run it")]),
			("r", MessageRole::ToolResult, vec![result]),
		]);
		let mut thread = thread(cx, opened(entries));
		let pieces = thread.plan(1).pieces;
		let captions: Vec<&str> = pieces
			.iter()
			.filter_map(|piece| match piece {
				Piece::Pane { caption, .. } => Some(caption.as_str()),
				_ => None,
			})
			.collect();
		assert_eq!(captions, vec![caption], "is_error: {is_error}");
	}
}
