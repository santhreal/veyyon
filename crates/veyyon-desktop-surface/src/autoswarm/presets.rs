//! The two preset controls a console row carries (§5.8).
//!
//! A preset is saved under the name the console's own save row holds, so the
//! control sits beside that row and commits it: the name is read when the
//! press lands rather than when the element was built, which is what keeps a
//! save from carrying the name the row held one frame ago.
//!
//! A delete acts on the preset the rows currently equal, which is the selected
//! option of the segmented row, and only a saved one can be removed. The
//! control is drawn only on that row and only while its selection is
//! removable, so a built-in carries no delete the host would reject.

use veyyon_desktop_kit::{Button, ButtonSize, ButtonVariant, InteractiveState, TokenSet};
use veyyon_desktop_model::{AutoswarmFieldView, SessionId, SurfaceId};
use veyyon_gpui::{AnyElement, Context, CursorStyle, IntoElement, ParentElement, Styled, div};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// True while `field` is the row whose selection can be removed.
#[must_use]
pub fn offers_delete(field: &AutoswarmFieldView) -> bool {
	field
		.options
		.iter()
		.any(|option| option.selected && option.removable)
}

/// The control that saves the setup under the name the save row holds.
pub fn save_button(
	row: &SessionId,
	field: &str,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let surface = SurfaceId::AutoswarmPresetSaveButton(row.clone());
	let (opacity, cursor, allowed) = availability_style(&controls.availability(&surface), tokens);
	let field = field.to_owned();
	let mut button = Button::new("autoswarm-preset-save", "Save")
		.size(ButtonSize::Small)
		.variant(ButtonVariant::Ghost);
	if allowed {
		button = button.on_click(cx.listener(move |view, _, _, cx| {
			view.submit_autoswarm_field(&field, cx);
		}));
	} else {
		button = button.state(InteractiveState::Disabled);
	}
	gated(button.into_any_element(), opacity, cursor)
}

/// The control that removes the saved preset the rows currently equal.
pub fn delete_button(
	row: &SessionId,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let surface = SurfaceId::AutoswarmPresetDeleteButton(row.clone());
	let (opacity, cursor, allowed) = availability_style(&controls.availability(&surface), tokens);
	let mut button = Button::new("autoswarm-preset-delete", "Delete")
		.size(ButtonSize::Small)
		.variant(ButtonVariant::Ghost);
	if allowed {
		button = button.on_click(cx.listener(|view, _, _, cx| {
			view.dispatch(Intent::DeleteAutoswarmPreset, cx);
		}));
	} else {
		button = button.state(InteractiveState::Disabled);
	}
	gated(button.into_any_element(), opacity, cursor)
}

/// The control drawn at the weight its gate gives it: a control waiting on an
/// answer reads as waiting rather than as withheld.
fn gated(control: AnyElement, opacity: f32, cursor: CursorStyle) -> AnyElement {
	div()
		.opacity(opacity)
		.cursor(cursor)
		.child(control)
		.into_any_element()
}
