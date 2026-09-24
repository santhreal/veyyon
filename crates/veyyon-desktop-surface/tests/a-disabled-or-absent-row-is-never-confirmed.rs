//! WHY: every picker in the window — a palette mode, a composer command list,
//! a settings page — runs on one `Picker`, and each of them decides for itself
//! which rows are selectable. A picker that confirms a disabled row, or moves
//! the selection onto one, turns a row drawn as unavailable into an action.
//!
//! CLASS CLOSED: the selectable mask is swept exhaustively — all sixteen
//! shapes of four rows, from every starting selection — so a rule that holds
//! for a contiguous run of enabled rows and fails on a gap is caught. The empty
//! list is swept separately, because a picker with nothing in it is where a
//! confirm reaches past the end.
//!
//! GAPS: what any one surface marks selectable. This pins what the shared
//! picker does with the mask it is given, not which rows a page disables.

use veyyon_desktop_kit::{Picker, PickerEvent, SelectionState};

#[test]
fn shared_picker_never_confirms_disabled_or_absent_rows() {
	for mask in 0_u8..16 {
		let rows: Vec<bool> = (0..4).map(|index| mask & (1 << index) != 0).collect();
		for selected in 0..rows.len() {
			let picker = Picker::new(&rows, selected);
			let confirm = picker.key("enter", |enabled| *enabled).unwrap();
			assert_eq!(
				confirm,
				if rows[selected] {
					PickerEvent::Confirm(selected)
				} else {
					PickerEvent::Handled
				}
			);
			assert_eq!(picker.pointer(selected, true, |enabled| *enabled), confirm);
			assert_eq!(
				picker.selection(selected, |enabled| *enabled),
				if rows[selected] {
					SelectionState::Selected
				} else {
					SelectionState::None
				}
			);
			for key in ["up", "down", "pageup", "pagedown", "home", "end"] {
				match picker.key(key, |enabled| *enabled).unwrap() {
					PickerEvent::Select(index) => {
						assert!(rows[index], "{mask}: {key} selected disabled row");
					},
					PickerEvent::Handled => assert_eq!(mask, 0),
					other => panic!("{key}: unexpected {other:?}"),
				}
			}
		}
	}
	let empty: [bool; 0] = [];
	for key in ["up", "down", "pageup", "pagedown", "home", "end", "enter"] {
		assert_eq!(Picker::new(&empty, 0).key(key, |enabled| *enabled), Some(PickerEvent::Handled));
	}
	assert_eq!(Picker::new(&empty, 0).key("escape", |enabled| *enabled), Some(PickerEvent::Dismiss));
	assert_eq!(Picker::new(&empty, 0).key("left", |enabled| *enabled), None);
}
