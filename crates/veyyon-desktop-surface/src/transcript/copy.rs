//! Taking a turn's words out of the window (§5.3, §8.25).
//!
//! The composer could copy its own text and nothing else could: a model's
//! answer, a command it ran, a path it named and a refusal it reported were all
//! drawn and unreachable. A right-click on a turn offers the one answer a
//! transcript owes a reader, and the words it copies are the words the turn
//! states.
//!
//! The projection is exhaustive over `Block`, so a block kind added to the
//! transcript states its text here or the crate does not compile.

use veyyon_desktop_kit::{AnchorCorner, IconName, Menu, MenuItem, Popover};
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Point, Styled, div,
};

use crate::{
	Intent, ShellView,
	damage::{LaidOut, Region},
	model::{Artifact, Block, Turn},
};

/// The turn menu that is open: which turn, and where the pointer was.
///
/// Window-local, like the queue's row menu: the state carries no record of it,
/// so a snapshot from the host never reopens a menu that was dismissed. The
/// text is taken when the menu opens rather than looked up when a row is
/// pressed, so the words copied are the words that were on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnMenu {
	pub turn:     usize,
	pub origin:   Point<Pixels>,
	pub text:     String,
	/// Whether this turn is a prompt, which is the only place a fork is cut.
	pub forkable: bool,
}

/// Which turn the last frame laid out over `at`, if any.
///
/// The boxes are the frame's own record, so a press resolves against what was
/// drawn rather than against a second layout pass: a turn scrolled out of the
/// viewport has no box the pointer can land in.
#[must_use]
pub fn turn_at(laid_out: &LaidOut, turns: usize, at: Point<Pixels>) -> Option<usize> {
	(0..turns).find(|turn| {
		laid_out
			.drawn_bounds(Region::Turn(*turn))
			.is_some_and(|bounds| bounds.contains(&at))
	})
}

/// The plain text a turn states, as a reader would take it out of the window.
///
/// Blocks are separated by a blank line, which is the gap the transcript draws
/// between them; the lines inside one block keep their own order.
#[must_use]
pub fn turn_text(turn: &Turn) -> String {
	match turn {
		Turn::Operator(text) => text.clone(),
		Turn::OperatorArtifacts { text, artifacts } => {
			let mut parts: Vec<String> = Vec::with_capacity(artifacts.len() + 1);
			if !text.is_empty() {
				parts.push(text.clone());
			}
			parts.extend(artifacts.iter().map(artifact_text));
			parts.join("\n\n")
		},
		Turn::Agent { blocks, .. } => blocks
			.iter()
			.map(block_text)
			.filter(|part| !part.is_empty())
			.collect::<Vec<String>>()
			.join("\n\n"),
	}
}

/// The plain text one block states.
fn block_text(block: &Block) -> String {
	match block {
		Block::Prose(text) | Block::Reason(text) => text.clone(),
		// The label is the word the row is drawn under, so a note reads the
		// same copied as it does on the canvas.
		Block::Note { label, text, .. } => {
			if text.is_empty() {
				(*label).to_string()
			} else {
				format!("{label}: {text}")
			}
		},
		Block::Invoke { tool, target, result, .. } => {
			let call = if target.is_empty() {
				tool.clone()
			} else {
				format!("{tool} {target}")
			};
			match result {
				Some(result) if !result.is_empty() => format!("{call}\n{result}"),
				_ => call,
			}
		},
		Block::Pane { caption, lines } => with_caption(caption, lines),
		Block::Unknown { producer, lines } => with_caption(producer, lines),
		Block::Artifact(artifact) => artifact_text(artifact),
	}
}

/// A caption above the lines it heads, either alone when the other is empty.
fn with_caption(caption: &str, lines: &[String]) -> String {
	let body = lines.join("\n");
	match (caption.is_empty(), body.is_empty()) {
		(true, _) => body,
		(false, true) => caption.to_owned(),
		(false, false) => format!("{caption}\n{body}"),
	}
}

/// What an artifact is called, since its bytes are no text.
fn artifact_text(artifact: &Artifact) -> String {
	match artifact {
		Artifact::Image { media_type, alt, .. } => alt.clone().unwrap_or_else(|| media_type.clone()),
		Artifact::File { path, .. } => path.clone(),
	}
}

/// The rows a turn menu offers, in the order they are drawn.
///
/// A fork is cut at a prompt, so the row that cuts one is offered on a prompt
/// and on nothing else: an answer is no entry a branch can fork at, and a
/// menu that offered the row there would name an entry the host refuses.
#[must_use]
pub fn turn_menu_items(menu: &TurnMenu) -> Vec<(MenuItem, Intent)> {
	let mut rows =
		vec![(MenuItem::new("Copy").icon(IconName::File), Intent::CopyText(menu.text.clone()))];
	if menu.forkable {
		rows.push((
			MenuItem::new("Branch from here").icon(IconName::Plus),
			Intent::BranchTurn(menu.turn),
		));
	}
	rows
}

/// The layer drawn over the window while a turn menu is open: a scrim that
/// takes the dismissing click, and the menu floated at the pointer.
pub fn turn_menu_layer(
	menu: &TurnMenu,
	selected: usize,
	focus: &veyyon_gpui::FocusHandle,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let items = turn_menu_items(menu)
		.into_iter()
		.enumerate()
		.map(|(index, (item, _))| item.highlighted(index == selected));
	let entity = cx.entity();
	let rows = Menu::new(items).on_select(move |index, _event, window, app| {
		entity.update(app, |view, cx| {
			view.menu_picker_pointer(crate::menu::MenuSource::Turn, index, window, cx);
		});
	});

	div()
		.id("transcript-turn-menu-scrim")
		.absolute()
		.inset_0()
		.on_mouse_down(
			MouseButton::Left,
			cx.listener(|view, _event, window, cx| {
				view.dismiss_picker_menu(window, cx);
			}),
		)
		.on_mouse_down(
			MouseButton::Right,
			cx.listener(|view, _event, window, cx| {
				view.dismiss_picker_menu(window, cx);
			}),
		)
		.child(Popover::new(menu.origin, AnchorCorner::TopLeft, rows).focus(focus))
}
