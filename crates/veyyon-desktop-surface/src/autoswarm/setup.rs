//! The console's setup: its rows, the notes under them, and the actions the
//! swarm's state allows (§5.8).
//!
//! Every value a row draws arrives formatted from the console model, and the
//! typed field beside it is what a change sends back. A window that formatted
//! the number itself would state `3` where the console states `3 arms`.

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, InteractiveState, SpacingStep, TextField,
	TextRamp, TextWeight, TintRole, TokenSet, input::Editor,
};
use veyyon_desktop_model::{
	AutoswarmConsoleView, AutoswarmFieldKind, AutoswarmFieldView, SessionId, SurfaceId,
};
use veyyon_desktop_tokens::AutoswarmSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, Entity, InteractiveElement, IntoElement, ParentElement, SharedString,
	Styled, div, px,
};

use super::{
	change::{option_change, step_change, toggle_change},
	presets::{delete_button, offers_delete, save_button},
};
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// The editor retained for each text row of the open console, paired with the
/// row id a change names.
pub type RowEditors = [(String, Entity<Editor>)];

/// The rows, the notes and the actions, in the order the console states them.
///
/// `row` is the rail row the console belongs to, which is what every control
/// of the card is keyed by: a refusal the host sends back lands on the control
/// that sent it, and the gate the window applies is read under the same key.
pub fn setup_section(
	console: &AutoswarmConsoleView,
	row: &SessionId,
	editors: &RowEditors,
	controls: &ControlStates,
	geometry: &AutoswarmSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	if console.is_read_only() {
		// `/autoresearch status` opens the ledger with no setup behind it:
		// there is state to read and nothing to change, so the card states
		// that rather than drawing an empty form.
		return div()
			.id("autoswarm-readonly")
			.pb(tokens.spacing(SpacingStep::S3))
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(tokens.line_height(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Muted))
			.child("This console reads the swarm. Run /autoresearch to change its setup.")
			.into_any_element();
	}

	let mut section = div()
		.id("autoswarm-setup")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.pb(tokens.spacing(SpacingStep::S4));

	for field in &console.fields {
		section = section.child(field_row(
			row,
			field,
			console.save_field.as_deref() == Some(field.id.as_str()),
			editors,
			controls,
			geometry,
			tokens,
			cx,
		));
	}

	for note in &console.notes {
		section = section.child(
			div()
				.id(SharedString::from(note.id.clone()))
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(note.text.clone()),
		);
	}

	section
		.child(actions_row(console, row, controls, tokens, cx))
		.into_any_element()
}

/// One row: its name, what it holds, the control that changes it, and the
/// preset controls the row carries.
///
/// `saves` is true on the row a preset is named in, which is the one the save
/// control commits. A delete is drawn beside the row holding the preset the
/// setup equals, so each control sits on the row it acts through.
fn field_row(
	row: &SessionId,
	field: &AutoswarmFieldView,
	saves: bool,
	editors: &RowEditors,
	controls: &ControlStates,
	geometry: &AutoswarmSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let surface = SurfaceId::AutoswarmField(row.clone(), field.id.clone());
	// A control the host has not answered for yet and one it will not answer
	// at all are two states, drawn at the two weights §4.3 gives them: a row
	// waiting on an answer reads as waiting rather than as withheld.
	let (opacity, cursor, allowed) = availability_style(&controls.availability(&surface), tokens);

	let label = div()
		.flex()
		.flex_col()
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(field.label.clone()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(field.hint.clone()),
		);

	let mut trailing = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.opacity(opacity)
		.cursor(cursor)
		.child(control(field, &field.id, editor_for(editors, &field.id), allowed, tokens, cx));
	if saves {
		trailing = trailing.child(save_button(row, &field.id, controls, tokens, cx));
	}
	if offers_delete(field) {
		trailing = trailing.child(delete_button(row, controls, tokens, cx));
	}

	// The console's row ids are unique across its setup, so the element
	// carries one: two rows whose ids differ only past a shared length would
	// otherwise draw under one id, and the second would be laid out as the
	// first.
	div()
		.id(SharedString::from(field.id.clone()))
		.flex()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S4))
		.h(px(geometry.row_height_px))
		.child(label)
		.child(trailing)
		.into_any_element()
}

/// The control a row draws, by the kind the console declared for it.
///
/// A text row draws the editor the window retained for it, so a keystroke
/// survives the rebuild of the element that drew it. A row with no editor yet
/// draws what the console states, which is the frame between the console
/// arriving and the shell installing its fields.
fn control(
	field: &AutoswarmFieldView,
	id: &str,
	editor: Option<Entity<Editor>>,
	allowed: bool,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	match field.kind {
		AutoswarmFieldKind::Toggle => {
			let label = if field.on.unwrap_or(false) {
				"On"
			} else {
				"Off"
			};
			change_button(
				("autoswarm-toggle", id.len()),
				label,
				allowed,
				cx,
				Some(toggle_change(field)),
			)
		},
		AutoswarmFieldKind::Stepper => stepper(field, id, allowed, tokens, cx),
		AutoswarmFieldKind::Segmented => segmented(field, allowed, tokens, cx),
		AutoswarmFieldKind::Text => match editor {
			Some(editor) => TextField::new(("autoswarm-text", id.len()), editor).into_any_element(),
			None => div()
				.id(("autoswarm-text-display", id.len()))
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(field.display.clone())
				.into_any_element(),
		},
	}
}

/// The editor retained for the row `id`, and None before the shell has
/// installed one for it.
fn editor_for(editors: &RowEditors, id: &str) -> Option<Entity<Editor>> {
	editors
		.iter()
		.find(|(field, _)| field == id)
		.map(|(_, editor)| editor.clone())
}

/// A stepper: what it holds, and one control per direction, each drawn only
/// while the bound it moves toward admits another step.
fn stepper(
	field: &AutoswarmFieldView,
	id: &str,
	allowed: bool,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(change_button(
			("autoswarm-step-down", id.len()),
			"-",
			allowed,
			cx,
			step_change(field, -1),
		))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(field.display.clone()),
		)
		.child(change_button(
			("autoswarm-step-up", id.len()),
			"+",
			allowed,
			cx,
			step_change(field, 1),
		))
		.into_any_element()
}

/// A segmented row: one control per option, the chosen one drawn filled.
fn segmented(
	field: &AutoswarmFieldView,
	allowed: bool,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let mut row = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));

	for (index, option) in field.options.iter().enumerate() {
		let change = option_change(field, index);
		let mut button = Button::new(("autoswarm-option", index), option.label.clone())
			.size(ButtonSize::Small)
			.variant(if option.selected {
				ButtonVariant::Primary
			} else {
				ButtonVariant::Ghost
			});
		match change.filter(|_| allowed) {
			Some(intent) => {
				button = button.on_click(cx.listener(move |view, _, _, cx| {
					view.dispatch(intent.clone(), cx);
				}));
			},
			// The option the row already holds stays lit and takes no press:
			// choosing it would send a change to the value it is on.
			None if !allowed => button = button.state(InteractiveState::Disabled),
			None => {},
		}
		row = row.child(button);
	}

	row.into_any_element()
}

/// A control that sends one change, drawn inert where the host has not
/// answered for it.
fn change_button(
	id: (&'static str, usize),
	label: impl Into<SharedString>,
	allowed: bool,
	cx: &Context<ShellView>,
	intent: Option<Intent>,
) -> AnyElement {
	let mut button = Button::new(id, label)
		.size(ButtonSize::Small)
		.variant(ButtonVariant::Ghost);
	// A control with no change behind it is drawn where it was, inert: a
	// stepper at its bound keeps the width it had, so the row does not move
	// under the pointer on the step that reached the bound.
	match intent.filter(|_| allowed) {
		Some(intent) => {
			button = button.on_click(cx.listener(move |view, _, _, cx| {
				view.dispatch(intent.clone(), cx);
			}));
		},
		None => button = button.state(InteractiveState::Disabled),
	}
	button.into_any_element()
}

/// The actions the swarm's state allows, primary first, each with the blocker
/// that stops it stated under the control rather than on the window's line.
fn actions_row(
	console: &AutoswarmConsoleView,
	row: &SessionId,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let mut strip = div()
		.id("autoswarm-actions")
		.flex()
		.items_start()
		.gap(tokens.spacing(SpacingStep::S3))
		.pt(tokens.spacing(SpacingStep::S3));

	for (index, action) in console.actions.iter().enumerate() {
		let name = action.action.as_str().to_owned();
		let surface = SurfaceId::AutoswarmActionButton(row.clone(), name);
		let (opacity, cursor, allowed) = availability_style(&controls.availability(&surface), tokens);
		let intent = Intent::RunAutoswarmAction(action.action);
		let mut button = Button::new(("autoswarm-action", index), action.label.clone())
			.size(ButtonSize::Medium)
			.variant(if action.primary {
				ButtonVariant::Primary
			} else {
				ButtonVariant::Ghost
			});
		if allowed && action.blocker.is_none() {
			button = button.on_click(cx.listener(move |view, _, _, cx| {
				view.dispatch(intent.clone(), cx);
			}));
		} else {
			button = button.state(InteractiveState::Disabled);
		}

		let mut column = div()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S1))
			.opacity(opacity)
			.cursor(cursor)
			.child(button);
		let footer = action
			.blocker
			.clone()
			.unwrap_or_else(|| action.verb.clone());
		let tint = if action.blocker.is_some() {
			tokens.tint(TintRole::Error).ink
		} else {
			tokens.color(ColorRole::Muted)
		};
		column = column.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tint)
				.child(footer),
		);
		strip = strip.child(column);
	}

	strip.into_any_element()
}
