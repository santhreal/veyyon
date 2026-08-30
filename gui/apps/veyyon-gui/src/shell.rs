//! The window: panel, transcript, composer, status bar.
//!
//! The shell holds view-models and nothing else. Every value it draws arrives
//! as a [`veyyon_presentation`] type, which today comes from that crate's
//! fixtures and later from a session over a transport — the shell cannot tell
//! the difference, which is the point of building it against the fixtures
//! first.

use gpui::{
	App, Context, Div, InteractiveElement, IntoElement, ParentElement, Render, Stateful,
	StatefulInteractiveElement, Styled, Window, div,
};
use veyyon_presentation::{
	PresentationCapabilities,
	composer::ComposerState,
	fixtures,
	overlay::{DialogViewModel, SelectOption},
	status::StatusLineState,
	transcript::TranscriptBlock,
};
use veyyon_theme::Role;
use veyyon_ui::{
	ActiveTypography, Level, surface,
	text::{caption, label, title},
	theme::{ActiveTheme, Theme},
	tokens::{layout, radius, space, stroke},
};

use crate::{
	blocks,
	chrome::{chip, column, row, rule, well},
	composer::composer,
	status::status_bar,
};

/// Everything the window draws.
pub struct Shell {
	blocks:       Vec<TranscriptBlock>,
	composer:     ComposerState,
	status:       StatusLineState,
	capabilities: PresentationCapabilities,
	/// The dialog on top, when one is open.
	dialog:       Option<DialogViewModel>,
}

impl Shell {
	/// A shell over the presentation fixtures.
	///
	/// `dialog` selects one of the fixture dialogs to open on top, by index. Out
	/// of range opens none, so a caller can ask for "no dialog" without a
	/// second spelling.
	pub fn from_fixtures(dialog: Option<usize>) -> Shell {
		let status = fixtures::status_lines()
			.into_iter()
			.find(|line| line.activity.is_busy())
			.expect("a fixture session is busy");
		let composer = fixtures::composer_states()
			.into_iter()
			.next()
			.expect("the fixtures carry a composer state");

		Shell {
			blocks: fixtures::transcript_blocks(),
			composer,
			status,
			capabilities: fixtures::capabilities(),
			dialog: dialog.and_then(|index| fixtures::dialogs().into_iter().nth(index)),
		}
	}
}

impl Render for Shell {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let content = row(space::HAIR)
			.flex_1()
			.min_h_0()
			.w_full()
			.items_start()
			.child(panel(self, cx))
			.child(main(self, cx));

		let mut root = surface(Level::Window, cx)
			.size_full()
			.flex()
			.flex_col()
			.text_color(cx.color(Role::TextPrimary))
			.font_family(cx.ui_family())
			.child(content)
			.child(status_bar(&self.status, cx));

		if let Some(dialog) = &self.dialog {
			root = root.child(modal(dialog, cx));
		}
		root
	}
}

/// The side panel: what this window is, and what it is showing.
fn panel(shell: &Shell, cx: &App) -> Div {
	let theme = cx.theme();
	let counts = row(space::TIGHT)
		.child(chip(format!("{} blocks", shell.blocks.len()), Role::TextSecondary, cx))
		.child(chip(theme.name().to_owned(), Role::TextAccent, cx));

	surface(Level::Panel, cx)
		.w(layout::PANEL)
		.min_w(layout::PANEL_MIN)
		.h_full()
		.p(space::BASE)
		.flex()
		.flex_col()
		.gap(space::LOOSE)
		.child(
			column(space::TIGHT)
				.child(title("veyyon", cx))
				.child(caption("gpu front end", cx))
				.child(counts),
		)
		.child(rule(Role::StrokeSubtle, cx))
		.child(section("Surface", capability_rows(shell.capabilities), cx))
		.child(section("Theme", theme_rows(theme), cx))
}

/// One labelled group of name/value rows.
fn section(heading: &'static str, rows: Vec<(String, String)>, cx: &App) -> Div {
	column(space::TIGHT)
		.child(caption(heading, cx))
		.children(rows.into_iter().map(|(name, value)| {
			row(space::SNUG)
				.w_full()
				.justify_between()
				.child(label(name, cx))
				.child(caption(value, cx))
		}))
}

/// What the surface reports it can do, as rows.
fn capability_rows(value: PresentationCapabilities) -> Vec<(String, String)> {
	let yes_no = |flag: bool| {
		if flag {
			"yes".to_owned()
		} else {
			"no".to_owned()
		}
	};
	vec![
		("images".to_owned(), yes_no(value.images)),
		("true colour".to_owned(), yes_no(value.true_color)),
		("mouse".to_owned(), yes_no(value.mouse)),
		("hyperlinks".to_owned(), yes_no(value.hyperlinks)),
		("native scrollback".to_owned(), yes_no(value.native_scrollback)),
		("text styles".to_owned(), yes_no(value.text_styles)),
	]
}

/// What the loaded theme is, as rows. The theme's own name is the chip above,
/// so it is not repeated here.
fn theme_rows(theme: &Theme) -> Vec<(String, String)> {
	vec![
		("appearance".to_owned(), appearance_label(theme.appearance()).to_owned()),
		("roles".to_owned(), Role::ALL.len().to_string()),
	]
}

fn appearance_label(value: veyyon_theme::Appearance) -> &'static str {
	match value {
		veyyon_theme::Appearance::Light => "light",
		veyyon_theme::Appearance::Dark => "dark",
	}
}

/// The transcript and the composer.
fn main(shell: &Shell, cx: &App) -> Div {
	surface(Level::Canvas, cx)
		.flex_1()
		.min_w_0()
		.h_full()
		.flex()
		.flex_col()
		.child(transcript(shell, cx))
		.child(
			div()
				.w_full()
				.p(space::LOOSE)
				.flex()
				.flex_col()
				.items_center()
				.child(composer(&shell.composer, cx)),
		)
}

/// The scrolling transcript.
///
/// One column of [`layout::READING`], centred, with the cards filling it: every
/// card shares a left and right edge, so a short message does not read as a
/// narrower card than the one above it.
fn transcript(shell: &Shell, cx: &App) -> Stateful<Div> {
	let stack = column(space::LOOSE)
		.w(layout::READING)
		.children(shell.blocks.iter().map(|value| blocks::block(value, cx)));
	let stack = if shell.blocks.is_empty() {
		stack.child(blocks::empty(cx))
	} else {
		stack
	};

	div()
		.id("transcript")
		.flex_1()
		.min_h_0()
		.w_full()
		.overflow_y_scroll()
		.p(space::WIDE)
		.flex()
		.flex_col()
		.items_center()
		.child(stack)
}

/// A dialog on top of everything.
///
/// Full-bleed scrim, so the dialog is the only thing that reads as reachable.
/// The scrim is the window ground at partial alpha rather than black, which
/// keeps a light theme from going grey.
fn modal(value: &DialogViewModel, cx: &App) -> Div {
	let scrim = cx.color(Role::SurfaceWindow);
	div()
		.absolute()
		.inset_0()
		.flex()
		.items_center()
		.justify_center()
		.bg(gpui::Hsla { a: 0.72, ..scrim })
		.child(veyyon_motion::dialog_in("dialog", dialog(value, cx)))
}

/// The dialog card.
fn dialog(value: &DialogViewModel, cx: &App) -> Div {
	let card = surface(Level::Overlay, cx)
		.w(layout::DIALOG)
		.p(space::LOOSE)
		.flex()
		.flex_col()
		.gap(space::BASE);

	match value {
		DialogViewModel::Confirm {
			title: heading,
			body,
			confirm_label,
			cancel_label,
			destructive,
			..
		} => card
			.child(title(heading.clone(), cx))
			.child(label(body.clone(), cx))
			.child(
				row(space::SNUG)
					.child(button(cancel_label.clone(), Role::TextSecondary, cx))
					.child(button(
						confirm_label.clone(),
						if *destructive {
							Role::StateError
						} else {
							Role::TextAccent
						},
						cx,
					)),
			),
		DialogViewModel::Select {
			title: heading,
			options,
			selected_index,
			multi,
			filterable,
			..
		} => card
			.child(title(heading.clone(), cx))
			.child(
				row(space::TIGHT)
					.children(multi.then(|| chip("multiple", Role::StateInfo, cx)))
					.children(filterable.then(|| chip("filterable", Role::TextMuted, cx))),
			)
			.children(options.iter().enumerate().map(|(index, option)| {
				choice(option, usize::try_from(*selected_index).ok() == Some(index), cx)
			})),
		DialogViewModel::Prompt { title: heading, placeholder, initial_value, masked, .. } => card
			.child(title(heading.clone(), cx))
			.children(masked.then(|| chip("hidden while typed", Role::TextMuted, cx)))
			.child(entry(placeholder, initial_value, *masked, cx)),
		DialogViewModel::ToolApproval { tool_name, input, impact, .. } => card
			.child(title(format!("Run {tool_name}?"), cx))
			.children(impact.as_ref().map(|text| label(text.clone(), cx)))
			.child(well(input.clone(), Role::TextPrimary, cx))
			.child(
				row(space::SNUG)
					.child(button("Reject", Role::StateError, cx))
					.child(button("Approve", Role::StateSuccess, cx)),
			),
	}
}

/// One option of a select dialog.
fn choice(option: &SelectOption, chosen: bool, cx: &App) -> Div {
	let disabled = option.disabled.unwrap_or(false);
	let role = if disabled {
		Role::TextMuted
	} else {
		Role::TextPrimary
	};
	let mut line = column(space::HAIR)
		.w_full()
		.px(space::SNUG)
		.py(space::TIGHT)
		.rounded(radius::SMALL)
		.child(label(option.label.clone(), cx).text_color(cx.color(role)));

	if chosen {
		line = line.bg(cx.color(Role::InteractionSelected));
	}
	if disabled {
		line = line.child(caption("unavailable", cx));
	}
	match &option.description {
		None => line,
		Some(text) => line.child(caption(text.clone(), cx)),
	}
}

/// A prompt's input line. Masked shows the character count rather than the
/// value, because a masked prompt is a credential.
fn entry(placeholder: &str, value: &str, masked: bool, cx: &App) -> Div {
	let shown = if value.is_empty() {
		placeholder.to_owned()
	} else if masked {
		"•".repeat(value.chars().count())
	} else {
		value.to_owned()
	};
	let role = if value.is_empty() {
		Role::TextMuted
	} else {
		Role::TextPrimary
	};
	well(shown, role, cx)
}

/// A button. Not interactive yet: there is nothing to send a
/// `UiEvent::DialogResult` to.
fn button(text: impl Into<gpui::SharedString>, role: Role, cx: &App) -> Div {
	let color = cx.color(role);
	div()
		.px(space::BASE)
		.py(space::TIGHT)
		.rounded(radius::SMALL)
		.border(stroke::HAIRLINE)
		.border_color(crate::chrome::edge(color))
		.bg(crate::chrome::wash(color))
		.text_color(color)
		.child(text.into())
}

/// WHY THIS SUITE EXISTS.
///
/// The shell's own decisions are which view-model it opens with and which
/// dialog it puts on top. The failure it closes is an out-of-range or absent
/// selection silently producing an empty window, which looks like a rendering
/// fault rather than a bad argument.
///
/// WHAT IT DOES NOT CATCH. Everything visual. Layout, ordering, scrolling and
/// the scrim all need a window, and the app's capture covers them.
#[cfg(test)]
mod tests {
	use super::*;

	/// A shell from the fixtures opens with every block, a busy status line and
	/// a composer in a mode that accepts input. An idle status line would draw
	/// no motion, which is the state that proves least.
	#[test]
	fn a_fixture_shell_opens_on_a_busy_session() {
		let shell = Shell::from_fixtures(None);
		assert_eq!(shell.blocks.len(), fixtures::transcript_blocks().len());
		assert!(shell.status.activity.is_busy());
		assert!(shell.dialog.is_none());
		assert_eq!(shell.composer.mode, veyyon_presentation::composer::ComposerMode::Input);
	}

	/// Every fixture dialog is selectable by index, and an index past the end
	/// opens none rather than panicking or wrapping to the first.
	#[test]
	fn a_dialog_index_selects_or_opens_nothing() {
		let count = fixtures::dialogs().len();
		assert!(count > 0, "the fixtures carry no dialogs");

		for index in 0..count {
			let shell = Shell::from_fixtures(Some(index));
			let opened = shell.dialog.expect("an in-range index opens a dialog");
			assert_eq!(opened.id(), fixtures::dialogs()[index].id());
		}
		assert!(Shell::from_fixtures(Some(count)).dialog.is_none());
		assert!(Shell::from_fixtures(Some(usize::MAX)).dialog.is_none());
	}

	/// The capability rows cover every field of the contract's capability
	/// struct. A field added there and not here is a capability the panel stops
	/// reporting, silently.
	#[test]
	fn the_capability_rows_cover_every_field() {
		let rows = capability_rows(PresentationCapabilities::GPU);
		let names: Vec<&str> = rows.iter().map(|(name, _)| name.as_str()).collect();
		assert_eq!(names, [
			"images",
			"true colour",
			"mouse",
			"hyperlinks",
			"native scrollback",
			"text styles"
		]);

		let json =
			serde_json::to_value(PresentationCapabilities::GPU).expect("capabilities serialize");
		let fields = json.as_object().expect("capabilities are an object");
		assert_eq!(fields.len(), rows.len(), "a capability field has no row");
	}
}
