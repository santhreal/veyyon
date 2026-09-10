//! WHY THIS SUITE EXISTS:
//! Two controls drawn side by side answered to one element id. Every kit
//! primitive resolved its id with `self.id.unwrap_or_else(|| ElementId::from(
//! "button"))` and almost no caller set one, so siblings shared a
//! `GlobalElementId` and with it one `pending_mouse_down` cell. The control
//! painted first cleared that cell in the mouse-up capture phase, because the
//! release was not over its own hitbox, and the control the pointer was
//! actually over fired nothing. A refusal the host marks retryable draws
//! `Retry` and `Dismiss` side by side, and pressing `Dismiss` did nothing.
//!
//! THE CLASS THIS CLOSES:
//! Any interactive kit primitive that routes clicks by an id it derives
//! itself rather than one the caller states. The sweep enumerates
//! `PrimitiveKind` at run time, draws every clickable one as a row of two to
//! four instances with distinct ids, and drives real `MouseMove`, `MouseDown`
//! and `MouseUp` input through a real window at the centre of every hit rect
//! the frame registered. A primitive that ignores the id it was given, or
//! regains a constant one, fails here rather than in a recording. A new
//! primitive fails to compile until `instance` classifies it, and the set that
//! is not swept is pinned by exact equality.
//!
//! WHAT IT DOES NOT CATCH:
//! A caller that passes one id to two siblings by hand -- that is now visible
//! at the call site rather than hidden in the primitive. The three primitives
//! that answer no press (a resizable grip answers a drag, the two text inputs
//! answer focus and keystrokes) are swept for neither. It asserts
//! which control fired, not what its handler then did.

use std::{
	path::PathBuf,
	sync::{Arc, Mutex},
};

use strum::IntoEnumIterator;
use veyyon_desktop::{AssetPaths, StartupBundle, load_startup_bundle};
use veyyon_desktop_kit::{
	Checkbox, CheckboxState, FilePicker, IconButton, ListRow, NumberInput, PrimitiveKind, Radio,
	SearchField, SegmentedControl, Select, Slider, Toggle, TreeRow,
	controls::{Button, ButtonSize},
	icons::IconName,
};
use veyyon_desktop_scene::{Appearance, RenderOptions, capture_window, headless_context};
use veyyon_desktop_surface::install_tokens;
use veyyon_gpui::{
	AnyElement, AnyWindowHandle, App, AppContext, Bounds, Context, HeadlessAppContext, IntoElement,
	Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
	PlatformInput, Point, Render, SharedString, Styled, Window, div, point, px,
};

/// Where a press lands and what it fired, shared with every control in the
/// row. The kit's handlers are `Send + Sync`, so this is a mutex and not a
/// cell.
type Recorder = Arc<Mutex<Vec<String>>>;

/// The window every row is drawn in.
const WINDOW: (u32, u32) = (760, 240);

/// The width each instance is given, so four of them fit side by side and a
/// row-shaped primitive does not take the whole width.
const SLOT_PX: f32 = 168.0;

/// The gap between two slots, and the padding the row starts at. The sweep
/// reads them back to say which instance a hit rect belongs to.
const SLOT_GAP_PX: f32 = 12.0;
const ROW_PAD_PX: f32 = 20.0;

/// The primitives this sweep presses nothing for, in four groups. Static
/// content answers no press at all: `Text`, `Truncate`, `Markdown`,
/// `CodeBlock`, `Kbd`, `Spacer`, `Divider`, `Badge`, `Dot`, `Spinner`,
/// `Meter`, `Avatar`. A container routes a press to the child under it and
/// fires nothing of its own, so the child is what this sweep draws instead:
/// `Stack`, `Row`, `ScrollView`, `Resizable`, `List`, `Tree`, `Table`. A text
/// input takes focus and keystrokes rather than a click handler: `TextField`,
/// `TextArea`. An overlay is drawn one at a time over everything else, so two
/// of them are never siblings, and the controls inside one are swept here as
/// their own kinds: `Sheet`, `Popover`, `Menu`, `Dialog`, `Tooltip`,
/// `Palette`.
///
/// Pinned by exact equality: a primitive that becomes clickable, or a new
/// one, must be classified rather than silently skipped.
const NOT_PRESSED: [PrimitiveKind; 27] = [
	PrimitiveKind::Text,
	PrimitiveKind::Truncate,
	PrimitiveKind::Markdown,
	PrimitiveKind::CodeBlock,
	PrimitiveKind::Kbd,
	PrimitiveKind::TextField,
	PrimitiveKind::TextArea,
	PrimitiveKind::Stack,
	PrimitiveKind::Row,
	PrimitiveKind::Spacer,
	PrimitiveKind::Divider,
	PrimitiveKind::ScrollView,
	PrimitiveKind::Resizable,
	PrimitiveKind::Sheet,
	PrimitiveKind::List,
	PrimitiveKind::Tree,
	PrimitiveKind::Table,
	PrimitiveKind::Popover,
	PrimitiveKind::Menu,
	PrimitiveKind::Dialog,
	PrimitiveKind::Tooltip,
	PrimitiveKind::Palette,
	PrimitiveKind::Badge,
	PrimitiveKind::Dot,
	PrimitiveKind::Spinner,
	PrimitiveKind::Meter,
	PrimitiveKind::Avatar,
];

/// Builds one instance of `kind` under `id`, reporting through `record` when a
/// press reaches it, or nothing when the primitive answers no press.
///
/// The match is exhaustive on purpose: a new primitive does not compile until
/// someone states which side of the sweep it belongs on.
fn instance(kind: PrimitiveKind, id: SharedString, record: &Recorder) -> Option<AnyElement> {
	let fired = record.clone();
	let name = id.to_string();
	let note = move || {
		fired
			.lock()
			.expect("the recorder is not poisoned")
			.push(name.clone());
	};

	let element = match kind {
		PrimitiveKind::Button => Button::new(id, "Retry")
			.size(ButtonSize::Small)
			.on_click(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::IconButton => IconButton::new(id, IconName::Stop)
			.on_click(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::Toggle => Toggle::new(id, true)
			.on_toggle(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::Checkbox => Checkbox::new(id, CheckboxState::Unchecked)
			.label("Enabled")
			.on_toggle(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::Radio => Radio::new(id, false)
			.label("Option")
			.on_select(move |_, _| note())
			.into_any_element(),
		PrimitiveKind::Select => Select::new(id, ["First", "Second"], 0)
			.on_open(move |_, _| note())
			.into_any_element(),
		PrimitiveKind::SegmentedControl => SegmentedControl::new(id, ["Left", "Right"], 0)
			.on_change(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::NumberInput => NumberInput::new(id, 4)
			.range(0, 10)
			.step(1)
			.on_change(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::SearchField => SearchField::new(id, "query")
			.on_clear(move |_, _| note())
			.into_any_element(),
		PrimitiveKind::FilePicker => FilePicker::new(id, Some(PathBuf::from("/repo/src/app.ts")))
			.on_browse(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::ListRow => ListRow::new(id, "Session")
			.subtitle("Detail")
			.on_click(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::TreeRow => TreeRow::new(id, "Node", 0)
			.on_click(move |_, _, _| note())
			.into_any_element(),
		PrimitiveKind::Slider => Slider::new(id, 0.5, 0.0, 1.0)
			.on_change(move |_, _, _| note())
			.into_any_element(),

		// A resizable grip answers a drag and the two text inputs answer focus
		// and keystrokes; none reports a press, so a press proves nothing
		// about their ids. Everything else here draws no control.
		PrimitiveKind::Resizable
		| PrimitiveKind::TextField
		| PrimitiveKind::TextArea
		| PrimitiveKind::Text
		| PrimitiveKind::Truncate
		| PrimitiveKind::Markdown
		| PrimitiveKind::CodeBlock
		| PrimitiveKind::Kbd
		| PrimitiveKind::Stack
		| PrimitiveKind::Row
		| PrimitiveKind::Spacer
		| PrimitiveKind::Divider
		| PrimitiveKind::ScrollView
		| PrimitiveKind::Sheet
		| PrimitiveKind::List
		| PrimitiveKind::Tree
		| PrimitiveKind::Table
		| PrimitiveKind::Popover
		| PrimitiveKind::Menu
		| PrimitiveKind::Dialog
		| PrimitiveKind::Tooltip
		| PrimitiveKind::Palette
		| PrimitiveKind::Badge
		| PrimitiveKind::Dot
		| PrimitiveKind::Spinner
		| PrimitiveKind::Meter
		| PrimitiveKind::Avatar => return None,
	};
	Some(element)
}

/// The tokens the primitives resolve their metrics against.
fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("bundled tokens and themes load")
}

/// A row of one primitive, repeated, each instance under its own id.
struct Row {
	kind:    PrimitiveKind,
	count:   usize,
	pressed: Recorder,
}

impl Render for Row {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let mut row = div()
			.flex()
			.flex_row()
			.items_start()
			.gap(px(SLOT_GAP_PX))
			.p(px(ROW_PAD_PX));
		for index in 0..self.count {
			let id = SharedString::from(format!("c{index}"));
			let child =
				instance(self.kind, id, &self.pressed).expect("a swept primitive builds an instance");
			row = row.child(div().w(px(SLOT_PX)).flex_shrink_0().child(child));
		}
		row
	}
}

/// Presses and releases the left button at one point, the way a pointer that
/// travelled there does: the move lands first, so the hitbox under it is
/// hovered before the press.
fn press_at(cx: &mut HeadlessAppContext, handle: AnyWindowHandle, at: Point<Pixels>) {
	let events = [
		PlatformInput::MouseMove(MouseMoveEvent {
			position:       at,
			pressed_button: None,
			modifiers:      Modifiers::default(),
		}),
		PlatformInput::MouseDown(MouseDownEvent {
			button:      MouseButton::Left,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
			first_mouse: false,
		}),
		PlatformInput::MouseUp(MouseUpEvent {
			button:      MouseButton::Left,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
		}),
	];
	for event in events {
		cx.update_window(handle, |_, window, app| {
			window.dispatch_event(event.clone(), app);
		})
		.expect("the window takes input");
		cx.run_until_parked();
	}
}

/// Which instance a hit rect belongs to, read from the row's own geometry
/// rather than from any id: the slots are laid out at known offsets, so the
/// grouping cannot be fooled by the ids the sweep is judging. A wrapper
/// carrying an id of its own would scope the children and hide the defect.
fn slot_of(rect: Bounds<Pixels>, count: usize) -> Option<usize> {
	let centre = f32::from(rect.origin.x + rect.size.width / 2.0);
	(0..count).find(|index| {
		let left = (SLOT_PX + SLOT_GAP_PX).mul_add(as_f32(*index), ROW_PAD_PX);
		centre >= left && centre < left + SLOT_PX
	})
}

/// `index` as a float, for the slot arithmetic above.
fn as_f32(index: usize) -> f32 {
	u16::try_from(index).map_or(f32::MAX, f32::from)
}

/// Draws `count` instances of `kind` and presses the centre of every hit rect
/// the frame registered, answering with what each press fired and which
/// instance the press landed in.
fn press_every_rect(kind: PrimitiveKind, count: usize) -> Vec<(usize, Vec<String>)> {
	let mut cx = headless_context().expect("an offscreen renderer");
	let bundle = startup_assets();
	let options = RenderOptions {
		width: WINDOW.0,
		height: WINDOW.1,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let pressed: Recorder = Arc::new(Mutex::new(Vec::new()));
	let recorded = pressed.clone();
	let window = cx
		.open_window(options.logical_size(), move |_window: &mut Window, app: &mut App| {
			install_tokens(app, &bundle.tokens, &bundle.theme, &bundle.surface_path)
				.expect("tokens install");
			app.new(move |_cx| Row { kind, count, pressed: recorded })
		})
		.expect("a window opens");
	cx.run_until_parked();
	let handle: AnyWindowHandle = window.into();
	let captured = capture_window(&mut cx, handle, options.scale_factor).expect("a frame");

	let mut answers = Vec::new();
	let mut covered = vec![false; count];
	for rect in &captured.hitboxes {
		let Some(index) = slot_of(*rect, count) else {
			panic!(
				"{kind:?} registered a hit rect at x={:?} that lies in no slot, so the sweep cannot \
				 tell which instance it belongs to",
				rect.origin.x
			);
		};
		covered[index] = true;
		let at = point(rect.origin.x + rect.size.width / 2.0, rect.origin.y + rect.size.height / 2.0);
		pressed
			.lock()
			.expect("the recorder is not poisoned")
			.clear();
		press_at(&mut cx, handle, at);
		let fired = pressed
			.lock()
			.expect("the recorder is not poisoned")
			.clone();
		answers.push((index, fired));
	}
	assert!(
		covered.iter().all(|slot| *slot),
		"{kind:?} drawn {count} times registered hit rects for only {} of them, so an instance \
		 answers no pointer at all",
		covered.iter().filter(|slot| **slot).count()
	);
	cx.update(|app| {
		let _ = window.update(app, |_, window, _| window.remove_window());
	});
	answers
}

#[test]
fn every_clickable_primitive_answers_the_press_it_is_under() {
	let recorder: Recorder = Arc::new(Mutex::new(Vec::new()));
	let swept: Vec<PrimitiveKind> = PrimitiveKind::iter()
		.filter(|kind| instance(*kind, SharedString::from("probe"), &recorder).is_some())
		.collect();
	assert!(!swept.is_empty(), "no primitive is swept, so the sweep proves nothing");

	for kind in swept {
		for count in 2..=4 {
			let answers = press_every_rect(kind, count);
			let mut reached = vec![false; count];
			for (index, fired) in &answers {
				for id in fired {
					assert_eq!(
						id,
						&format!("c{index}"),
						"a press inside instance {index} of {kind:?} fired {id}, so two instances share \
						 one id"
					);
					reached[*index] = true;
				}
			}
			for (index, hit) in reached.iter().enumerate() {
				assert!(
					*hit,
					"instance {index} of {count} {kind:?} answered no press at all, so its id is not \
					 its own"
				);
			}
		}
	}
}

#[test]
fn a_primitive_that_is_not_swept_is_recorded_rather_than_forgotten() {
	let recorder: Recorder = Arc::new(Mutex::new(Vec::new()));
	let skipped: Vec<PrimitiveKind> = PrimitiveKind::iter()
		.filter(|kind| instance(*kind, SharedString::from("probe"), &recorder).is_none())
		.collect();
	assert_eq!(
		skipped,
		NOT_PRESSED.to_vec(),
		"the set of primitives no press is driven through changed; classify the new one rather than \
		 leaving it unswept"
	);
}
