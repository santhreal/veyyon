//! Shell and Python execution transcript entries.

use gpui::{App, Div, ParentElement, Styled, px};
use veyyon_gui_kit::{
	theme::space,
	ui::{Badge, Icon, Tone, text},
};

use super::code;

pub fn execution(
	id: &str,
	language: &str,
	command: Option<&str>,
	output: &str,
	exit_code: Option<i32>,
	cx: &mut App,
) -> Div {
	let failed = exit_code.is_some_and(|code| code != 0);
	let mut column = text::stack(space::TIGHT).w_full().min_w(px(0.0)).child(
		Badge::new(if language.eq_ignore_ascii_case("python") {
			"Python"
		} else {
			"Shell"
		})
		.tone(if failed { Tone::Danger } else { Tone::Muted })
		.icon(Icon::Ran),
	);
	if let Some(command) = command.filter(|command| !command.trim().is_empty()) {
		column = column.child(code::well(&format!("{id}-command"), language, command, cx));
	}
	if !output.is_empty() {
		column = column.child(code::well(&format!("{id}-output"), "text", output, cx));
	}
	if let Some(exit_code) = exit_code {
		column = column.child(
			Badge::new(format!("Exit {exit_code}"))
				.tone(if failed { Tone::Danger } else { Tone::Ok })
				.bare(),
		);
	}
	column
}
