//! The line under the composer: one badge and the detail the badge cannot say.
//!
//! WHY: the run bar drew the badge chip and then a label holding the badge's
//! own name, so a running turn read `Working Working`. The chip states the
//! state; the line states what the state is about, and says nothing when the
//! state is all there is to report.

use veyyon_desktop_model::{SessionBadge, SessionId, Store};
use veyyon_desktop_surface::Badge;

use super::queue::badge;

/// The run bar's badge and its line, or `None` when the session is idle.
pub(super) fn run_status(
	store: &Store,
	active: Option<&SessionId>,
	derived: Option<&SessionBadge>,
) -> Option<(Badge, String)> {
	let id = active?;
	let derived = derived?;
	let line = match derived {
		// A stream names the tool it is running; the badge already says the
		// turn is working, so a stream with no tool adds nothing.
		SessionBadge::Working { .. } => store
			.streaming
			.get(id)
			.and_then(|stream| stream.tool.clone())
			.unwrap_or_default(),
		SessionBadge::Approval => store
			.interactions
			.get(id)
			.and_then(|pending| pending.approvals.first())
			.map(|approval| {
				if approval.detail.is_empty() {
					approval.tool_name.clone()
				} else {
					format!("{} · {}", approval.tool_name, approval.detail)
				}
			})
			.unwrap_or_default(),
		SessionBadge::Input => store
			.interactions
			.get(id)
			.and_then(|pending| pending.questions.first())
			.map(|question| question.prompt.clone())
			.unwrap_or_default(),
		SessionBadge::Plan => store
			.interactions
			.get(id)
			.and_then(|pending| pending.plans.first())
			.map(|plan| first_line(&plan.markdown_plan))
			.unwrap_or_default(),
		SessionBadge::Watching => store
			.domains
			.processes
			.iter()
			.filter(|process| process.is_alive())
			.map(|process| process.name.clone())
			.collect::<Vec<_>>()
			.join(", "),
		// A finished turn, a failure and an elapsed deferral are reported
		// where they happened: the transcript, the error's own control, and
		// the row. The bar names the state and stops.
		SessionBadge::Failed | SessionBadge::Due | SessionBadge::Done => String::new(),
	};
	Some((badge(derived), line))
}

/// The first non-empty line of a block of markdown.
fn first_line(markdown: &str) -> String {
	markdown
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.unwrap_or_default()
		.to_string()
}
