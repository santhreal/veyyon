//! Deterministic scene construction and headless rendering for kit primitives
//! (§8.25, §8.30).

use std::path::PathBuf;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{
	AnchorCorner, Avatar, AvatarSize, Axis, Badge, Button, ButtonVariant, Checkbox, CheckboxState,
	CodeBlock, Dialog, DialogButtonSpec, Divider, Dot, FilePicker, Icon, IconButton, IconName,
	IconSize, Kbd, KeyChord, List, ListRow, Markdown, Menu, MenuItem, Meter, NumberInput, Palette,
	Popover, PrimitiveKind, Radio, Resizable, Row, ScrollView, SearchField, SegmentedControl,
	Select, Sheet, Slider, Spacer, Spinner, SpinnerSize, Stack, Table, TableColumn, Text, TextArea,
	TextField, TextRamp, Toggle, Tooltip, Tree, TreeRow, Truncate,
	token_set::{ColorRole, SpacingStep, TintRole, TokenSet},
};
use veyyon_gpui::{
	AnyElement, App, AppContext, Context, HeadlessAppContext, IntoElement, ParentElement, Point,
	Render, Styled, Window, div,
};

use crate::{
	contact_sheet::{SheetCell, SheetGrid, tile},
	fixtures::FixtureText,
	frame::RgbaFrame,
	headless::{RenderError, RenderOptions, render_view},
};

/// Constructs the deterministic visual element for a kit primitive.
#[must_use]
pub fn render_primitive(kind: PrimitiveKind, _window: &mut Window, cx: &mut App) -> AnyElement {
	let default_tokens = TokenSet::default();
	let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

	match kind {
		PrimitiveKind::Text => Stack::vertical(SpacingStep::S2)
			.child(Text::new(FixtureText::CJK).ramp(TextRamp::Head))
			.child(Text::new(FixtureText::RTL).ramp(TextRamp::Body))
			.child(Text::new(FixtureText::EMOJI_ZWJ_CLUSTER).ramp(TextRamp::Small))
			.into_any_element(),

		PrimitiveKind::Truncate => div()
			.w(tokens.spacing(SpacingStep::S13))
			.child(
				Truncate::new(FixtureText::BRANCH_EXTREME_90)
					.max_width(tokens.spacing(SpacingStep::S13)),
			)
			.into_any_element(),

		PrimitiveKind::Markdown => Markdown::new(format!(
			"## {}\n\n- {}\n- {}",
			FixtureText::TITLE_TYPICAL,
			FixtureText::CJK,
			FixtureText::EMOJI_ZWJ_CLUSTER
		))
		.into_any_element(),

		PrimitiveKind::CodeBlock => CodeBlock::new(format!(
			"// {}\nfn extreme() -> &'static str {{\n\t\"{}\"\n}}",
			FixtureText::CJK,
			FixtureText::BRANCH_EXTREME_90
		))
		.language("rust")
		.line_numbers(true)
		.into_any_element(),

		PrimitiveKind::Kbd => Stack::horizontal(SpacingStep::S2)
			.child(Kbd::chords([KeyChord::key("P").meta().shift()]))
			.child(Kbd::new(FixtureText::PROJECT_EXTREME_SINGLE))
			.into_any_element(),

		PrimitiveKind::Button => Stack::horizontal(SpacingStep::S2)
			.child(
				Button::new(FixtureText::CJK)
					.variant(ButtonVariant::Primary)
					.leading_icon(IconName::Settings),
			)
			.child(Button::new(FixtureText::PROJECT_EXTREME_SINGLE).variant(ButtonVariant::Default))
			.into_any_element(),

		PrimitiveKind::SplitButton => {
			veyyon_desktop_kit::SplitButton::new(FixtureText::PROJECT_TYPICAL)
				.variant(ButtonVariant::Primary)
				.into_any_element()
		},

		PrimitiveKind::IconButton => Stack::horizontal(SpacingStep::S2)
			.child(IconButton::new(IconName::Search))
			.child(IconButton::new(IconName::Settings))
			.into_any_element(),

		PrimitiveKind::Toggle => Stack::horizontal(SpacingStep::S4)
			.child(Toggle::new(true))
			.child(Toggle::new(false))
			.into_any_element(),

		PrimitiveKind::Checkbox => Stack::vertical(SpacingStep::S2)
			.child(Checkbox::new(CheckboxState::Checked).label(FixtureText::RTL))
			.child(Checkbox::new(CheckboxState::Unchecked).label(FixtureText::CJK))
			.into_any_element(),

		PrimitiveKind::Radio => Stack::vertical(SpacingStep::S2)
			.child(Radio::new(true).label(FixtureText::PROJECT_EXTREME_SINGLE))
			.child(Radio::new(false).label(FixtureText::PROJECT_TYPICAL))
			.into_any_element(),

		PrimitiveKind::Select => {
			Select::new([FixtureText::BRANCH_EXTREME_90, FixtureText::CJK], 0).into_any_element()
		},

		PrimitiveKind::Slider => Slider::new(0.68, 0.0, 1.0).into_any_element(),

		PrimitiveKind::SegmentedControl => SegmentedControl::new(
			[FixtureText::PROJECT_TYPICAL, FixtureText::CJK, FixtureText::PROJECT_EXTREME_SINGLE],
			1,
		)
		.into_any_element(),

		PrimitiveKind::NumberInput => NumberInput::new(42)
			.range(0, 100)
			.step(1)
			.into_any_element(),

		PrimitiveKind::TextField => TextField::new(FixtureText::BRANCH_EXTREME_90)
			.placeholder("Branch name...")
			.into_any_element(),

		PrimitiveKind::TextArea => {
			TextArea::new(format!("{}\n{}", FixtureText::MESSAGE_TYPICAL, FixtureText::CJK))
				.placeholder("Notes...")
				.into_any_element()
		},

		PrimitiveKind::SearchField => SearchField::new(FixtureText::CJK)
			.placeholder("Search symbols...")
			.into_any_element(),

		PrimitiveKind::FilePicker => {
			FilePicker::new(Some(PathBuf::from(FixtureText::FILE_PATH_EXTREME))).into_any_element()
		},

		PrimitiveKind::Stack => Stack::vertical(SpacingStep::S2)
			.child(Text::new("Stack Entry 1"))
			.child(Text::new(FixtureText::CJK))
			.child(Text::new(FixtureText::RTL))
			.into_any_element(),

		PrimitiveKind::Row => Row::new(SpacingStep::S3)
			.child(Icon::new(IconName::Folder).size(IconSize::Size14))
			.child(Text::new(FixtureText::PROJECT_TYPICAL))
			.child(Badge::new(FixtureText::PROJECT_EXTREME_SINGLE, TintRole::Approve))
			.into_any_element(),

		PrimitiveKind::Spacer => Stack::vertical(SpacingStep::S0)
			.child(Text::new("Top Section"))
			.child(Spacer::new(SpacingStep::S4))
			.child(Text::new("Bottom Section"))
			.into_any_element(),

		PrimitiveKind::Divider => Stack::vertical(SpacingStep::S2)
			.child(Text::new("Upper Content"))
			.child(Divider::horizontal())
			.child(Text::new("Lower Content"))
			.into_any_element(),

		PrimitiveKind::ScrollView => ScrollView::new(Stack::vertical(SpacingStep::S2).children(
			(0..6).map(|i| Text::new(format!("Scroll Item {i} - {}", FixtureText::PROJECT_TYPICAL))),
		))
		.into_any_element(),

		PrimitiveKind::Resizable => Resizable::new(
			Axis::Horizontal,
			Text::new(FixtureText::PROJECT_TYPICAL),
			Text::new(FixtureText::CJK),
		)
		.ratio(0.5)
		.into_any_element(),

		PrimitiveKind::Sheet => Sheet::bottom(
			Stack::vertical(SpacingStep::S2)
				.child(Text::new(FixtureText::TITLE_TYPICAL))
				.child(Button::new("Dismiss")),
		)
		.into_any_element(),

		PrimitiveKind::List => List::new(4, |idx, _, _| {
			Text::new(format!("Item {idx}: {}", FixtureText::BRANCH_TYPICAL)).into_any_element()
		})
		.into_any_element(),

		PrimitiveKind::ListRow => ListRow::new(FixtureText::BRANCH_EXTREME_90)
			.subtitle(FixtureText::CJK)
			.trailing(Badge::new(FixtureText::PROJECT_EXTREME_SINGLE, TintRole::Approve))
			.into_any_element(),

		PrimitiveKind::Tree => Tree::new(3, |idx, _, _| {
			TreeRow::new(format!("Node {idx} - {}", FixtureText::PROJECT_TYPICAL), idx)
				.branch(idx == 0)
				.expanded(idx == 0)
				.into_any_element()
		})
		.into_any_element(),

		PrimitiveKind::TreeRow => TreeRow::new(FixtureText::FILE_PATH_TYPICAL, 1)
			.branch(true)
			.expanded(true)
			.icon(IconName::Folder)
			.into_any_element(),

		PrimitiveKind::Table => {
			Table::new([TableColumn::new("Target"), TableColumn::new("Status")], 3, |r, c, _, _| {
				match c {
					0 => Text::new(format!("Row {r}")).into_any_element(),
					_ => Badge::new("Ok", TintRole::Done).into_any_element(),
				}
			})
			.into_any_element()
		},

		PrimitiveKind::Popover => Popover::new(
			Point::new(tokens.spacing(SpacingStep::S2), tokens.spacing(SpacingStep::S2)),
			AnchorCorner::TopLeft,
			Text::new(FixtureText::MESSAGE_TYPICAL),
		)
		.into_any_element(),

		PrimitiveKind::Menu => Menu::new([
			MenuItem::new(FixtureText::PROJECT_TYPICAL).icon(IconName::Settings),
			MenuItem::new(FixtureText::CJK).shortcut("⌘K"),
		])
		.into_any_element(),

		PrimitiveKind::Dialog => {
			Dialog::new(FixtureText::TITLE_TYPICAL, Text::new(FixtureText::MESSAGE_TYPICAL))
				.action(DialogButtonSpec::new("Confirm", ButtonVariant::Primary))
				.into_any_element()
		},

		PrimitiveKind::Tooltip => {
			Tooltip::new(FixtureText::BRANCH_EXTREME_90, Button::new("Inspect Target"))
				.into_any_element()
		},

		PrimitiveKind::Palette => Palette::new(
			SearchField::new("").placeholder("Command palette..."),
			List::new(2, |i, _, _| Text::new(format!("Command {i}")).into_any_element()),
		)
		.into_any_element(),

		PrimitiveKind::Badge => Stack::horizontal(SpacingStep::S2)
			.child(Badge::new(FixtureText::EMOJI_ZWJ_CLUSTER, TintRole::Approve))
			.child(Badge::new(FixtureText::PROJECT_EXTREME_SINGLE, TintRole::Working))
			.into_any_element(),

		PrimitiveKind::Dot => Stack::horizontal(SpacingStep::S3)
			.child(Dot::new(TintRole::Working).pulsing(true))
			.child(Dot::new(TintRole::Error))
			.child(Dot::new(TintRole::Done))
			.into_any_element(),

		PrimitiveKind::Spinner => Spinner::new().size(SpinnerSize::Large).into_any_element(),

		PrimitiveKind::Meter => Meter::new(0.72).into_any_element(),

		PrimitiveKind::Avatar => Avatar::new(FixtureText::PROJECT_EXTREME_SINGLE)
			.size(AvatarSize::Large)
			.into_any_element(),
	}
}

/// Headless view container wrapping a primitive scene.
pub struct PrimitiveSceneView {
	kind: PrimitiveKind,
}

impl PrimitiveSceneView {
	/// Creates a new scene view for the specified primitive kind.
	#[must_use]
	pub const fn new(kind: PrimitiveKind) -> Self {
		Self { kind }
	}

	/// Returns the primitive kind of this scene view.
	#[must_use]
	pub const fn kind(&self) -> PrimitiveKind {
		self.kind
	}
}

impl Render for PrimitiveSceneView {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let ground = tokens.color(ColorRole::Canvas);
		let pad = tokens.spacing(SpacingStep::S4);

		let element = render_primitive(self.kind, window, cx);

		div()
			.size_full()
			.bg(ground)
			.p(pad)
			.flex()
			.items_center()
			.justify_center()
			.child(element)
	}
}

/// Renders a single primitive scene to an RGBA frame.
pub fn render_primitive_scene(
	cx: &mut HeadlessAppContext,
	kind: PrimitiveKind,
	options: &RenderOptions,
) -> Result<RgbaFrame, RenderError> {
	render_view(cx, options, |_window, app: &mut App| {
		app.set_global(TokenSet::default());
		app.new(|_| PrimitiveSceneView::new(kind))
	})
}

/// Renders all 41 primitive scenes in inventory order.
pub fn render_all_primitive_scenes(
	cx: &mut HeadlessAppContext,
	options: &RenderOptions,
) -> Result<Vec<(PrimitiveKind, RgbaFrame)>, RenderError> {
	let mut frames = Vec::with_capacity(41);
	for kind in PrimitiveKind::iter() {
		let frame = render_primitive_scene(cx, kind, options)?;
		frames.push((kind, frame));
	}
	Ok(frames)
}

/// Generates a unified contact sheet containing all 41 primitive scenes.
pub fn generate_kit_coverage_sheet(
	cx: &mut HeadlessAppContext,
	options: &RenderOptions,
	grid: SheetGrid,
) -> Result<RgbaFrame, RenderError> {
	let rendered = render_all_primitive_scenes(cx, options)?;
	let cells: Vec<SheetCell> = rendered
		.into_iter()
		.map(|(kind, frame)| {
			let label = format!("kit/{kind:?}");
			SheetCell::new(label, frame)
		})
		.collect();

	tile(cx, cells, grid, options.scale_factor)
}
