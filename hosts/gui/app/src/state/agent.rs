//! What answers a send while no engine is attached.
//!
//! This is the one module the engine replaces. It composes a reply out of the
//! same [`Block`]s a real turn arrives as, and hands back the activity the
//! session lands in. Everything downstream — the streaming reveal, autoscroll,
//! the sidebar's ordering, the unread mark, the interrupt — is the production
//! path and does not know the difference.
//!
//! It is not a placeholder for the transcript's SHAPE. A placeholder returns
//! something inert so a screen can be photographed; this returns a turn that
//! reads a file, prints a diff, asks a question or fails, so every branch the
//! transcript draws is reachable by typing.

use super::model::{Activity, Block, ToolState};

/// How long after a send the first characters arrive.
pub const FIRST_TOKEN_MS: u64 = 220;
/// How long between reveals of prose.
pub const TEXT_MS: u64 = 16;
/// How many bytes of prose each reveal adds.
pub const TEXT_STEP: usize = 3;
/// How long a whole block takes to land.
pub const BLOCK_MS: u64 = 180;
/// How long between terminal lines.
pub const LINE_MS: u64 = 90;

/// A composed reply.
pub struct Reply {
	pub blocks:  Vec<Block>,
	pub ends_as: Activity,
}

/// The title a session takes from its first send.
///
/// The first line, cut at a word boundary. A session called by its opening
/// words is findable in the sidebar; one called "New session" is not.
pub fn title_for(text: &str) -> String {
	const BUDGET: usize = 48;
	let line = text
		.lines()
		.find(|line| !line.trim().is_empty())
		.unwrap_or(text)
		.trim();
	if line.chars().count() <= BUDGET {
		return line.to_owned();
	}
	let mut out = String::new();
	for word in line.split_whitespace() {
		if out.chars().count() + word.chars().count() + 1 > BUDGET {
			break;
		}
		if !out.is_empty() {
			out.push(' ');
		}
		out.push_str(word);
	}
	if out.is_empty() {
		line.chars().take(BUDGET).collect()
	} else {
		out
	}
}

/// Compose an answer to `text`.
///
/// Routed on what was asked, so the reply is about the message rather than the
/// same paragraph every time: a question asks back, a broken command fails, a
/// read shows a file, an edit shows a diff.
pub fn reply(text: &str) -> Reply {
	let lower = text.to_lowercase();
	if lower.ends_with('?') || lower.starts_with("should") || lower.starts_with("which") {
		return Reply {
			blocks:  vec![Block::Text(
				"Two ways to go, and they differ in what breaks later.\n\nThe first keeps the current \
				 shape and costs a second pass over every call site. The second changes the boundary \
				 once and every call site follows from it.\n\nWhich do you want?"
					.to_owned(),
			)],
			ends_as: Activity::Waiting,
		};
	}
	if lower.contains("fail") || lower.contains("break") || lower.contains("crash") {
		let mut blocks = vec![Block::Text("Running the gate first.".to_owned())];
		blocks.extend(calling(
			"bash",
			"cargo test -p veyyon-gui",
			"error: 2 tests failed",
			ToolState::Failed,
		));
		blocks.push(Block::Text(
			"Two tests fail before my change, so the tree was already red. Stopping rather than \
			 committing on top of it."
				.to_owned(),
		));
		return Reply { blocks, ends_as: Activity::Failed };
	}
	if lower.contains("read") || lower.contains("look at") || lower.contains("open") {
		let mut blocks = vec![Block::Text("Reading it now.".to_owned())];
		blocks.extend(calling("read", "src/state/moves.rs", "412 lines", ToolState::Ok));
		blocks.push(Block::Text(
			"It is one function per move, each taking `&mut Store`. The interesting part is `tick`, \
			 which is the only place a deadline is compared against the clock:"
				.to_owned(),
		));
		blocks.push(Block::Code {
			lang: "rust".to_owned(),
			body: "pub fn tick(store: &mut Store, now_ms: u64) -> bool {\n\tstore.now_ms = \
			       now_ms;\n\tlet mut moved = false;\n\t// every deadline in the store is against \
			       store.now_ms\n\tmoved\n}"
				.to_owned(),
		});
		return Reply { blocks, ends_as: Activity::Done };
	}
	if lower.contains("diff") || lower.contains("change") || lower.contains("fix") {
		return Reply {
			blocks:  vec![
				Block::Text("Here is the change.".to_owned()),
				Block::Diff {
					path:  "app/src/state/moves.rs".to_owned(),
					lines: vec![
						(' ', "pub fn select(store: &mut Store, id: &SessionId) {".to_owned()),
						('-', "\tstore.selected = Some(id.clone());".to_owned()),
						('+', "\tif store.session(id).is_none() {".to_owned()),
						('+', "\t\treturn;".to_owned()),
						('+', "\t}".to_owned()),
						('+', "\tstore.selected = Some(id.clone());".to_owned()),
						(' ', "\tstore.route = Route::Chat;".to_owned()),
					],
				},
				Block::Text(
					"Selecting a session that is not in the store now leaves the selection alone \
					 instead of pointing at nothing."
						.to_owned(),
				),
			],
			ends_as: Activity::Done,
		};
	}
	let mut blocks = vec![Block::Text(
		"Taking that as the next step. The state module is where it lands: every move is a function \
		 over the store, so the window renders one value and nothing else holds a copy of it."
			.to_owned(),
	)];
	blocks.extend(calling("search", "state/", "6 files", ToolState::Ok));
	blocks.push(Block::Text("Starting with the moves that the sidebar reads.".to_owned()));
	Reply { blocks, ends_as: Activity::Done }
}

/// What a command prints, and what it exits with.
pub fn command_output(command: &str) -> (Vec<String>, Option<i32>) {
	match command {
		"cargo check" => (
			vec![
				"    Checking veyyon-gui v0.1.0 (hosts/gui/app)".to_owned(),
				"    Finished `dev` profile in 3.41s".to_owned(),
			],
			Some(0),
		),
		"bun test" => (
			vec![
				"bun test v1.3.0".to_owned(),
				"".to_owned(),
				" 42 pass".to_owned(),
				" 0 fail".to_owned(),
			],
			Some(0),
		),
		_ => (vec![format!("$ {command}"), format!("error: no such command: {command}")], Some(127)),
	}
}

/// A tool call, as the two blocks it really arrives as: the call, then its
/// result. The second replaces the first, so the transcript shows one call that
/// runs and then settles.
fn calling(name: &str, target: &str, output: &str, state: ToolState) -> [Block; 2] {
	[Block::tool(name, target, "", ToolState::Running), Block::tool(name, target, output, state)]
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! This module is the seam the engine replaces, so the contract worth
	//! holding is not the wording of a reply: it is that every branch a
	//! transcript can draw is reachable, and that a session's landing activity
	//! comes from the reply rather than from the sender. A reply that always
	//! ended `Done` would make the waiting and failed rows unreachable by
	//! typing, which is how the sidebar's whole ordering went untested before.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the prose is any good.

	use super::*;

	#[test]
	fn a_question_ends_the_turn_waiting_for_an_answer() {
		assert_eq!(reply("which one should it be?").ends_as, Activity::Waiting);
	}

	#[test]
	fn a_reply_about_something_broken_ends_failed_and_carries_a_failed_tool() {
		let reply = reply("the gate fails");
		assert_eq!(reply.ends_as, Activity::Failed);
		assert!(
			reply
				.blocks
				.iter()
				.any(|block| matches!(block, Block::Tool { state: ToolState::Failed, .. })),
			"a failed turn drew no failed tool call, so the failure state is unreachable"
		);
	}

	#[test]
	fn every_block_shape_is_reachable_by_sending_something() {
		let sends = ["read the file", "fix the diff", "the build breaks", "carry on"];
		let blocks: Vec<Block> = sends.iter().flat_map(|send| reply(send).blocks).collect();
		assert!(blocks.iter().any(|block| matches!(block, Block::Text(_))));
		assert!(
			blocks
				.iter()
				.any(|block| matches!(block, Block::Code { .. }))
		);
		assert!(
			blocks
				.iter()
				.any(|block| matches!(block, Block::Tool { .. }))
		);
		assert!(
			blocks
				.iter()
				.any(|block| matches!(block, Block::Diff { .. })),
			"nothing a user can type produces a diff, so the diff renderer is dead code"
		);
	}

	#[test]
	fn every_activity_a_reply_can_end_in_is_produced_by_some_send() {
		let sends = ["which way?", "it crashes", "read it", "go on"];
		let mut ends: Vec<Activity> = sends.iter().map(|send| reply(send).ends_as).collect();
		ends.sort_by_key(|activity| activity.rank());
		ends.dedup();
		assert_eq!(ends, vec![Activity::Waiting, Activity::Failed, Activity::Done]);
	}

	#[test]
	fn a_title_is_cut_at_a_word_and_never_mid_word() {
		let title =
			title_for("port the grep kernel to the new matcher and keep the old flags working");
		assert!(title.chars().count() <= 48);
		assert!(!title.ends_with(' '));
		assert!(
			"port the grep kernel to the new matcher and keep the old flags working"
				.starts_with(&title)
		);
	}

	#[test]
	fn a_short_send_is_its_own_title() {
		assert_eq!(title_for("run the gate"), "run the gate");
	}

	#[test]
	fn a_title_ignores_leading_blank_lines() {
		assert_eq!(title_for("\n\n  read src/main.rs  \n"), "read src/main.rs");
	}

	#[test]
	fn an_unknown_command_exits_nonzero_and_says_which_command() {
		let (lines, exit) = command_output("gate.sh");
		assert_eq!(exit, Some(127));
		assert!(lines.iter().any(|line| line.contains("gate.sh")));
	}
}
