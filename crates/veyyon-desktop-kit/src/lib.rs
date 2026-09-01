//! Token-driven primitive kit for the veyyon desktop front end.
//!
//! Exposes the 41 primitive components across 7 groups, resolving all visual
//! attributes from design tokens and motion roles (§8.24).

#![allow(
	clippy::type_complexity,
	clippy::missing_const_for_fn,
	clippy::struct_field_names,
	clippy::suboptimal_flops,
	clippy::doc_markdown,
	clippy::map_unwrap_or,
	clippy::derive_partial_eq_without_eq,
	clippy::allow_attributes_without_reason,
	clippy::collapsible_if,
	reason = "ergonomic kit component builder types and callbacks"
)]

extern crate veyyon_gpui as gpui;

pub mod controls;
pub mod geometry;
pub mod icons;
pub mod indicators;
pub mod input;
pub mod layout;
pub mod lists;
pub mod overlays;
pub mod state;
pub mod text;
pub mod token_set;

pub use controls::*;
pub use geometry::*;
pub use icons::*;
pub use indicators::*;
pub use input::*;
pub use layout::*;
pub use lists::*;
pub use overlays::*;
pub use state::*;
pub use text::*;
pub use token_set::*;

/// Primitive inventory category group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, strum::EnumIter)]
pub enum PrimitiveGroup {
	Text,
	Controls,
	Input,
	Layout,
	Lists,
	Overlays,
	Indicators,
}

/// Enumeration of all 41 primitive component slots in the kit (§6.7).
///
/// Reconciled with §6.7's 41-slot inventory table (under the ceiling of 44):
/// - Text (5 slots, 7 names): `Text` (`Label`, `Mono`), `Truncate`, `Markdown`,
///   `CodeBlock`, `Kbd`. `OpeningLine` from previous draft is removed as
///   opening line is a §5 surface, not a kit primitive.
/// - Controls (10 slots): `Button`, `SplitButton`, `IconButton`, `Toggle`,
///   `Checkbox`, `Radio`, `Select`, `Slider`, `SegmentedControl`,
///   `NumberInput`. `SplitButton` is restored from §6.7; `NumberInput` is
///   placed in Controls per §6.7 table.
/// - Input (4 slots): `TextField`, `TextArea`, `SearchField`, `FilePicker`.
/// - Layout (7 slots): `Stack`, `Row`, `Spacer`, `Divider`, `ScrollView`,
///   `Resizable`, `Sheet`. `Row` and `Divider` are restored from §6.7.
/// - Lists (5 slots): `List`, `ListRow`, `Tree`, `TreeRow`, `Table`. `TreeRow`
///   is restored from §6.7; `VirtualList` is removed as virtualization is built
///   into `List`.
/// - Overlays (5 slots): `Popover`, `Menu`, `Dialog`, `Tooltip`, `Palette`.
///   `AttentionStrip` is removed as attention strip is a surface state
///   decoration (§8.24), not a primitive.
/// - Indicators (5 slots): `Badge`, `Dot`, `Spinner`, `Meter`, `Avatar`. `Icon`
///   is removed from indicators as icons are §6.8 vector assets rather than an
///   indicator primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, strum::EnumIter)]
pub enum PrimitiveKind {
	// Group 1: Text (5 slots)
	Text,
	Truncate,
	Markdown,
	CodeBlock,
	Kbd,

	// Group 2: Controls (10 slots)
	Button,
	SplitButton,
	IconButton,
	Toggle,
	Checkbox,
	Radio,
	Select,
	Slider,
	SegmentedControl,
	NumberInput,

	// Group 3: Input (4 slots)
	TextField,
	TextArea,
	SearchField,
	FilePicker,

	// Group 4: Layout (7 slots)
	Stack,
	Row,
	Spacer,
	Divider,
	ScrollView,
	Resizable,
	Sheet,

	// Group 5: Lists (5 slots)
	List,
	ListRow,
	Tree,
	TreeRow,
	Table,

	// Group 6: Overlays (5 slots)
	Popover,
	Menu,
	Dialog,
	Tooltip,
	Palette,

	// Group 7: Indicators (5 slots)
	Badge,
	Dot,
	Spinner,
	Meter,
	Avatar,
}

impl PrimitiveKind {
	/// Returns the category group this primitive belongs to.
	#[must_use]
	pub const fn group(self) -> PrimitiveGroup {
		match self {
			Self::Text | Self::Truncate | Self::Markdown | Self::CodeBlock | Self::Kbd => {
				PrimitiveGroup::Text
			},

			Self::Button
			| Self::SplitButton
			| Self::IconButton
			| Self::Toggle
			| Self::Checkbox
			| Self::Radio
			| Self::Select
			| Self::Slider
			| Self::SegmentedControl
			| Self::NumberInput => PrimitiveGroup::Controls,

			Self::TextField | Self::TextArea | Self::SearchField | Self::FilePicker => {
				PrimitiveGroup::Input
			},

			Self::Stack
			| Self::Row
			| Self::Spacer
			| Self::Divider
			| Self::ScrollView
			| Self::Resizable
			| Self::Sheet => PrimitiveGroup::Layout,

			Self::List | Self::ListRow | Self::Tree | Self::TreeRow | Self::Table => {
				PrimitiveGroup::Lists
			},

			Self::Popover | Self::Menu | Self::Dialog | Self::Tooltip | Self::Palette => {
				PrimitiveGroup::Overlays
			},

			Self::Badge | Self::Dot | Self::Spinner | Self::Meter | Self::Avatar => {
				PrimitiveGroup::Indicators
			},
		}
	}
}
