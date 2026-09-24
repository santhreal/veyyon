//! What a console row sends when it is changed (§5.8).
//!
//! The rules a control is drawn from and the change it sends are one
//! definition: a stepper draws its `-` disabled exactly when a step down sends
//! nothing, and a segmented row draws the option it holds filled exactly when
//! choosing it sends nothing. Two definitions would let a control be offered
//! that sends nothing when pressed.
//!
//! A row sends the value alone. The console formats what the row states, so
//! `3 arms` is the host's spelling of the `3` this sends back.

use veyyon_desktop_model::AutoswarmFieldView;

use crate::Intent;

/// The change a text row sends for the text it holds.
#[must_use]
pub fn text_change(field: &str, text: &str) -> Intent {
	Intent::SetAutoswarmField {
		field:  field.to_owned(),
		text:   Some(text.to_owned()),
		number: None,
		on:     None,
	}
}

/// The change a toggle sends: the value it is not holding. A row the console
/// stated no value for reads as off, so its control turns it on.
#[must_use]
pub fn toggle_change(field: &AutoswarmFieldView) -> Intent {
	Intent::SetAutoswarmField {
		field:  field.id.clone(),
		text:   None,
		number: None,
		on:     Some(!field.on.unwrap_or(false)),
	}
}

/// The change a stepper sends for one step of `delta`, and `None` when the
/// bound it moves toward admits no further step. A row the console stated no
/// number for steps from zero.
#[must_use]
pub fn step_change(field: &AutoswarmFieldView, delta: i64) -> Option<Intent> {
	let current = field.number.unwrap_or(0);
	let next = current.checked_add(delta)?;
	if field.min.is_some_and(|min| next < min) || field.max.is_some_and(|max| next > max) {
		return None;
	}
	Some(Intent::SetAutoswarmField {
		field:  field.id.clone(),
		text:   None,
		number: Some(next),
		on:     None,
	})
}

/// The change a segmented row sends for the option at `index`, and `None` when
/// no such option is offered or it is the one the row already holds.
#[must_use]
pub fn option_change(field: &AutoswarmFieldView, index: usize) -> Option<Intent> {
	let option = field.options.get(index)?;
	if option.selected {
		return None;
	}
	Some(Intent::SetAutoswarmField {
		field:  field.id.clone(),
		text:   Some(option.value.clone()),
		number: None,
		on:     None,
	})
}
