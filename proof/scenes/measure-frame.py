#!/usr/bin/env python3
"""Read a desktop window's own geometry out of a captured frame.

A scene that clicks a card or a menu row has to know where that row is, and the
two ways of knowing are not equal. A row position counted down from a surface's
top restates the product's layout in the scene, so it lands a section out the
moment the rail draws an extra partition, and it goes on landing there quietly
-- the click hits a neighbouring row, the frame looks plausible, and the take
publishes it. What the frame itself shows cannot go stale that way.

Both readings here work the same way. A surface the product fills -- a selected
card, an opaque menu -- covers its own box in one colour, and that colour is
what most of the box comes to. Find the colour, find the box it fills, and the
ink inside the box is the rows: a card's fill against the rail's ground, or a
menu's items against the menu's ground. Nothing in either reading names a
colour, a row height or an item count, so a retheme moves both with it.

Every reading fails closed with the count it actually found, because a wrong aim
is worse than no aim: a scene that abandons the take says so in one line, and a
scene that clicked the row below Export publishes a pair naming the wrong item.

    measure-frame.py selected-card <frame> <left> <top> <width> <height> <card-px>
        -> "<top> <left>" of the one filled card in a queue rail

    measure-frame.py menu-rows <frame> <origin-x> <origin-y> <items> <item>
                     <window-bottom>
        -> "<y> <x> <strength>" at the centre of one item's row in a menu
           floated at <origin-x>,<origin-y>, with the row's ink strength as a
           percentage of the menu's first row, which is the one item no gate
           decides. A row the gate refused is drawn at a fraction of its
           strength (§4.3), so a scene that reads under 100 there is about to
           click an answer that answers nothing. Strength compares one ink
           colour against another: a row drawn in the danger colour reads
           lower than an offered ordinary row.

    measure-frame.py filled-band <frame> <left> <top> <width> <height> <colour>
                     [<band> <bands>]
        -> "<y> <x>" at the centre of the one box a colour fills inside the
           rectangle. A transcript is anchored to its foot, so a scene that
           counted a turn down from the column's top would aim at the empty
           space a short session leaves; the operator's own turn is the one
           thing in the column drawn on a fill, so it is found by that fill
           wherever the column put it. The fill is matched exactly, since the
           elevations a surface is drawn at sit within FUZZ of each other.
           Two arguments name one of several boxes: <band> is 1-based from the
           top and <bands> is how many the rectangle must hold, so a session
           of two prompts states which of them is aimed at and a session that
           drew one prompt, or three, abandons the take instead of aiming at
           whichever box came first.

    measure-frame.py filled-box <frame> <left> <top> <width> <height> <colour>
                     [<band> <bands>]
        -> "<top> <left> <height> <width>" of that same box, as the rectangle
           it occupies. A press aims at a centre, and a drag has two ends and a
           region to be read over, so a gesture across a box reads the box and
           computes its own ends from it.

    measure-frame.py menu-item <frame> <left> <top> <width> <height> <colour>
                     <item> <items>
        -> "<y> <x> <strength>" at the centre of one item's row in a menu the
           rectangle holds. The box comes from the exact fill a floated
           surface is drawn on, so a transcript fill a few levels away from it
           never merges with the menu, and the rows are then the bands of ink
           inside that box: <items> names how many the menu must hold, so a
           menu that grew or lost a row abandons the take instead of clicking
           whichever band came <item>th. Strength is read as `menu-rows` reads
           it, against the menu's own first row.

All coordinates are root coordinates, and every reading is taken through
ImageMagick so a scene needs nothing a recorder container does not already
carry.
"""

import subprocess
import sys

# A colour matches within this much of the one looked for. Ample for the
# antialiasing a fill's own rounded corner draws, and far under the distance
# from any fill to any ink drawn on it.
FUZZ = "5%"
# No fuzz at all, for a reading that tells one elevation from the next. The
# roles a surface is drawn at sit a few levels apart -- an inset and a float
# differ by seven of 255 in each channel -- so a fuzzy match reads a turn's own
# fill and a menu floated over it as one colour, and finds each in the other's
# box. A frame draws a fill at the value the theme states, so the reading that
# has to tell them apart asks for exactly that.
EXACT = "0%"
# How much of a row or column has to be the colour for the row or column to
# count as inside the box: over half for a card's fill, which glyphs sit on, and
# a lower share down a menu's ground, whose strip is mostly text.
FILL_SHARE = 0.5
COLUMN_GROUND_SHARE = 0.6
ROW_GROUND_SHARE = 0.2
# How far past its last ground row a menu is still looked for, so a hairline
# drawn across it does not end the box at its top edge.
ROW_GROUND_TOLERANCE = 16
# The strip a floated menu's ground is read from: past the corner radius, and
# inside the narrowest menu a label comes to.
PROBE_LEFT, PROBE_RIGHT = 16, 40
SEARCH_W = 320
MIN_BAND_PX = 3
# A menu's rows come at one pitch, or the bands are not the rows of one menu.
PITCH_TOLERANCE = 4
# How far apart two bands of one fill may be and still be one box. A card's
# title and its workspace line are drawn across the whole card, so a row of
# glyphs takes the fill under FILL_SHARE and cuts the card's own band in
# three. The gap a line of text opens is a line tall; the height check below
# is what rejects a merge that joined two real boxes.
GLYPH_GAP_TOLERANCE = 16
# How much of a row or column a fill has to cover for the row or column to be
# inside the box it fills. A turn's own fill takes under half the column it is
# drawn in, since the bubble is set to a share of the measure and aligned to
# one edge, so this sits well under FILL_SHARE.
FILLED_BAND_SHARE = 0.1
# How many of a menu's outermost pixels are its own border and the radius it is
# rounded to, which no row of it is read over.
BORDER_INSET_PX = 3
# How much of a row a label inks before the row counts as an item. A line of
# type across a menu's measure comes to a tenth of it and more; a stray column
# -- a hairline the menu is drawn over, a divider behind it -- comes to one
# pixel of the row, and a floor of one pixel makes every row of the menu an
# item and finds one band covering all of them.
ROW_INK_SHARE = 0.04


def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def crop_of(left, top, width, height):
    return f"{width}x{height}+{left}+{top}"


def histogram(frame, crop):
    """Every colour in the crop, most of the crop first.

    ImageMagick names a colour it has a name for -- `black`, `grey98` -- and
    prints `srgb(...)` for the rest, so a reading that looked for `srgb(` could
    not see the one colour a transcript is mostly made of. The hex form is the
    field every line carries.
    """
    counted = []
    for line in run([
        "magick", frame, "-crop", crop, "+repage", "-depth", "8", "-format", "%c",
        "histogram:info:-",
    ]).splitlines():
        head, _, tail = line.strip().partition(":")
        if "#" not in tail:
            continue
        hexed = tail.split("#")[1].split()[0][:6]
        if len(hexed) < 6:
            continue
        try:
            counted.append((int(head), f"#{hexed}"))
        except ValueError:
            continue
    counted.sort(reverse=True)
    return counted


def shares(frame, crop, colour, axis, span, fuzz=FUZZ):
    """How much of each row, or of each column, of the crop is `colour`.

    The crop is flattened to the colour and everything else, then scaled to one
    column or one row, which leaves each entry's mean -- the share -- in a grey
    level ImageMagick prints.
    """
    geometry = f"1x{span}!" if axis == "row" else f"{span}x1!"
    dump = run([
        "magick", frame, "-crop", crop, "+repage",
        "-fuzz", fuzz, "-fill", "white", "-opaque", colour,
        "-fill", "black", "+opaque", "white",
        "-colorspace", "Gray", "-scale", geometry, "-depth", "8", "txt:-",
    ])
    read = {}
    for line in dump.splitlines():
        if line.startswith("#") or "gray(" not in line:
            continue
        head, _, tail = line.partition(":")
        if "," not in head:
            continue
        x, y = head.split(",")[:2]
        read[int(y) if axis == "row" else int(x)] = int(tail.split("gray(")[1].split(")")[0]) / 255
    return [read.get(index, 0.0) for index in range(span)]


def grey_peak(frame, crop):
    """The brightest grey in the crop, which is the ink drawn on the ground."""
    return float(run([
        "magick", frame, "-crop", crop, "+repage",
        "-colorspace", "Gray", "-format", "%[fx:maxima*255]", "info:",
    ]).strip())


def grey_of(colour):
    """One colour's grey level, so ink is compared against its own ground."""
    return float(run([
        "magick", "-size", "1x1", f"xc:{colour}",
        "-colorspace", "Gray", "-format", "%[fx:maxima*255]", "info:",
    ]).strip())


def runs(profile, floor, minimum=MIN_BAND_PX):
    """The stretches of the profile at or over the floor."""
    found, current = [], None
    for index, share in enumerate(profile):
        if share >= floor:
            current = (index, index) if current is None else (current[0], index)
        elif current is not None:
            found.append(current)
            current = None
    if current is not None:
        found.append(current)
    return [band for band in found if band[1] - band[0] >= minimum]


def merged(bands, gap):
    """Bands separated by less than `gap`, read as one."""
    joined = []
    for band in bands:
        if joined and band[0] - joined[-1][1] <= gap:
            joined[-1] = (joined[-1][0], band[1])
        else:
            joined.append(band)
    return joined


def fail(reason, code):
    print(reason, file=sys.stderr)
    raise SystemExit(code)


def selected_card(argv):
    """The one card a queue rail fills, which is the session the window is on."""
    frame, left, top, width, height, card_px = (
        argv[0], int(argv[1]), int(argv[2]), int(argv[3]), int(argv[4]), int(argv[5]),
    )
    crop = crop_of(left, top, width, height)
    counted = histogram(frame, crop)
    if len(counted) < 2:
        fail("the rail drew one colour, so no card is filled", 1)
    # The rail's ground is most of it; the fill is what the one selected card
    # covers, which is the next largest area no glyph comes to.
    fill = counted[1][1]

    filled = merged(runs(shares(frame, crop, fill, "row", height), FILL_SHARE), GLYPH_GAP_TOLERANCE)
    if len(filled) != 1:
        fail(f"the rail filled {len(filled)} boxes, not the one card the window is on", 2)
    first, last = filled[0]
    drawn = last - first + 1
    if abs(drawn - card_px) > 2:
        fail(f"the filled box is {drawn}px tall against a {card_px}px card", 3)

    # Read across the card's own rows, so a column reports the fill's width
    # rather than its share of the whole rail.
    card = crop_of(left, top + first, width, drawn)
    columns = merged(
        runs(shares(frame, card, fill, "column", width), FILL_SHARE), GLYPH_GAP_TOLERANCE
    )
    if len(columns) != 1:
        fail(f"the fill came to {len(columns)} column runs, not one card's width", 4)
    print(top + first, left + columns[0][0])


def one_filled_box(argv):
    """The one box a colour fills inside a rectangle, as <top> <left> <height> <width>."""
    frame, left, top, width, height, colour = (
        argv[0], int(argv[1]), int(argv[2]), int(argv[3]), int(argv[4]), argv[5],
    )
    band, wanted = (int(argv[6]), int(argv[7])) if len(argv) > 7 else (1, 1)
    if not 1 <= band <= wanted:
        fail(f"box {band} is not one of the {wanted} asked for", 64)
    crop = crop_of(left, top, width, height)
    bands = merged(
        runs(shares(frame, crop, colour, "row", height, EXACT), FILLED_BAND_SHARE),
        GLYPH_GAP_TOLERANCE,
    )
    if len(bands) != wanted:
        fail(f"{colour} fills {len(bands)} boxes in the rectangle, not the {wanted} looked for", 1)
    first, last = bands[band - 1]

    # Read across the box's own rows, so a column reports the fill's width
    # rather than its share of the whole rectangle.
    box = crop_of(left, top + first, width, last - first + 1)
    columns = merged(
        runs(shares(frame, box, colour, "column", width, EXACT), FILLED_BAND_SHARE),
        GLYPH_GAP_TOLERANCE,
    )
    if len(columns) != 1:
        fail(f"{colour} came to {len(columns)} column runs inside the box, not one", 2)
    return top + first, left + columns[0][0], last - first + 1, columns[0][1] - columns[0][0] + 1


def filled_band(argv):
    """One box a colour fills inside a rectangle, of the number it must hold."""
    top, left, height, width = one_filled_box(argv)
    print(top + height // 2, left + width // 2)


def filled_box(argv):
    """The same box, as the rectangle it occupies rather than its centre."""
    top, left, height, width = one_filled_box(argv)
    print(top, left, height, width)


def menu_rows(argv):
    """One item's row in a menu floated with its corner at the pointer."""
    frame, origin_x, origin_y, items, item, window_bottom = (
        argv[0], int(argv[1]), int(argv[2]), int(argv[3]), int(argv[4]), int(argv[5]),
    )
    if not 1 <= item <= items:
        fail(f"item {item} is not one of the {items} rows asked for", 64)
    height = max(0, window_bottom - origin_y)
    strip = PROBE_RIGHT - PROBE_LEFT
    counted = histogram(
        frame, crop_of(origin_x + PROBE_LEFT, origin_y, strip, min(80, height))
    )
    if not counted:
        fail("nothing was drawn below the corner the menu opened at", 1)
    ground = counted[0][1]

    # How far the ground runs down from the corner is how tall the menu is.
    rows = shares(
        frame, crop_of(origin_x + PROBE_LEFT, origin_y, strip, height), ground, "row", height
    )
    bottom, missed = origin_y, 0
    for offset, share in enumerate(rows):
        if share >= ROW_GROUND_SHARE:
            bottom, missed = origin_y + offset, 0
            continue
        missed += 1
        if missed > ROW_GROUND_TOLERANCE:
            break

    span = bottom - origin_y + 1
    columns = shares(
        frame, crop_of(origin_x, origin_y, SEARCH_W, span), ground, "column", SEARCH_W
    )
    anchor = (PROBE_LEFT + PROBE_RIGHT) // 2
    if columns[anchor] < COLUMN_GROUND_SHARE:
        fail(f"no menu ground below {origin_x}+{origin_y}", 2)
    left = right = anchor
    while left - 1 >= 0 and columns[left - 1] >= COLUMN_GROUND_SHARE:
        left -= 1
    while right + 1 < SEARCH_W and columns[right + 1] >= COLUMN_GROUND_SHARE:
        right += 1

    # Inside the box, a row carrying anything but ground is an item.
    inside = shares(
        frame, crop_of(origin_x + left, origin_y, right - left + 1, span), ground, "row", span
    )
    bands = runs([1.0 - share for share in inside], 1.0 / (right - left + 1))
    # A band touching the menu's own edge is that edge, drawn or antialiased; an
    # item's band cannot, because the menu pads its rows away from it.
    bands = [band for band in bands if band[0] > 0 and origin_y + band[1] < bottom]
    if len(bands) != items:
        fail(
            f"the menu drew {len(bands)} rows of ink, not {items}: "
            + ", ".join(f"{origin_y + top}-{origin_y + foot}" for top, foot in bands[:12]),
            3,
        )

    tops = [top for top, _ in bands]
    pitches = [tops[index + 1] - tops[index] for index in range(len(tops) - 1)]
    # A menu of one row states no pitch, so there is nothing to check it
    # against: it is read for where that row is and no further.
    if pitches:
        mean = sum(pitches) / len(pitches)
        if any(abs(pitch - mean) > mean / PITCH_TOLERANCE for pitch in pitches):
            fail(f"the menu's rows came at {pitches}px, which is not one item height", 4)

    # How strongly the row is inked, against the menu's first row, which is the
    # one item no gate decides. A refused answer is drawn at a fraction of its
    # strength, so the scene reads whether the row it is about to click answers
    # anything.
    box = right - left + 1
    ground_grey = grey_of(ground)
    def strength_of(band):
        crop = crop_of(origin_x + left, origin_y + band[0], box, band[1] - band[0] + 1)
        return max(0.0, grey_peak(frame, crop) - ground_grey)

    reference = strength_of(bands[0])
    if reference <= 0.0:
        fail("the menu's first row carries no ink to measure the rest against", 5)
    top, foot = bands[item - 1]
    strength = round(100 * strength_of(bands[item - 1]) / reference)
    print(origin_y + (top + foot) // 2, origin_x + (left + right) // 2, strength)


def ink_bands(frame, crop, colour, span):
    """The bands of ink a menu's ground carries, which are its rows.

    The box was found by the exact fill, so inside it the ground is read within
    FUZZ instead: a row of ground carries the antialiasing of the corner the
    menu is rounded to and of the hairline it is bordered with, and an exact
    reading counts that as ink and finds one band covering the whole menu.

    A band under MIN_BAND_PX is a hairline drawn across the menu, and a band
    touching the box's own edge is its corner; an item's band is neither,
    because the menu pads its rows away from its edges and a label is a line
    of type tall.
    """
    inside = shares(frame, crop, colour, "row", span)
    bands = runs([1.0 - share for share in inside], ROW_INK_SHARE)
    return [band for band in bands if band[0] > 0 and band[1] < span - 1]


def menu_item(argv):
    """One item's row in a menu the rectangle holds, found by its own fill."""
    frame, left, top, width, height, colour, item, items = (
        argv[0], int(argv[1]), int(argv[2]), int(argv[3]), int(argv[4]), argv[5],
        int(argv[6]), int(argv[7]),
    )
    if not 1 <= item <= items:
        fail(f"item {item} is not one of the {items} rows asked for", 64)
    crop = crop_of(left, top, width, height)
    boxes = merged(
        runs(shares(frame, crop, colour, "row", height, EXACT), FILLED_BAND_SHARE),
        GLYPH_GAP_TOLERANCE,
    )
    if len(boxes) != 1:
        fail(f"{colour} fills {len(boxes)} boxes in the rectangle, not the one menu", 1)
    first, last = boxes[0]
    span = last - first + 1
    columns = merged(
        runs(
            shares(frame, crop_of(left, top + first, width, span), colour, "column", width, EXACT),
            FILLED_BAND_SHARE,
        ),
        GLYPH_GAP_TOLERANCE,
    )
    if len(columns) != 1:
        fail(f"{colour} came to {len(columns)} column runs inside the menu, not one", 2)
    menu_left, menu_right = columns[0]
    box = menu_right - menu_left + 1

    # The hairline a menu is bordered with runs down its outermost columns, and
    # every row of the menu crosses it, so a row of pure ground between two
    # labels reads as inked and the rows come out as one band. The rows are
    # read inside the border instead.
    inset = min(BORDER_INSET_PX, box // 4)
    reading_left = left + menu_left + inset
    reading_w = box - 2 * inset
    if reading_w < MIN_BAND_PX:
        fail(f"the menu came to {box}px across, which is narrower than its own border", 2)
    bands = ink_bands(frame, crop_of(reading_left, top + first, reading_w, span), colour, span)
    if len(bands) != items:
        fail(
            f"the menu drew {len(bands)} rows of ink, not {items}: "
            + ", ".join(f"{top + first + band[0]}-{top + first + band[1]}" for band in bands[:12]),
            3,
        )

    tops = [band[0] for band in bands]
    pitches = [tops[index + 1] - tops[index] for index in range(len(tops) - 1)]
    if pitches:
        mean = sum(pitches) / len(pitches)
        if any(abs(pitch - mean) > mean / PITCH_TOLERANCE for pitch in pitches):
            fail(f"the menu's rows came at {pitches}px, which is not one item height", 4)

    ground_grey = grey_of(colour)

    def strength_of(band):
        crop = crop_of(reading_left, top + first + band[0], reading_w, band[1] - band[0] + 1)
        return max(0.0, grey_peak(frame, crop) - ground_grey)

    reference = strength_of(bands[0])
    if reference <= 0.0:
        fail("the menu's first row carries no ink to measure the rest against", 5)
    band = bands[item - 1]
    strength = round(100 * strength_of(band) / reference)
    print(
        top + first + (band[0] + band[1]) // 2,
        left + (menu_left + menu_right) // 2,
        strength,
    )


READINGS = {
    "selected-card": (selected_card, (6,)),
    "filled-band": (filled_band, (6, 8)),
    "filled-box": (filled_box, (6, 8)),
    "menu-rows": (menu_rows, (6,)),
    "menu-item": (menu_item, (8,)),
}


def main(argv):
    if not argv or argv[0] not in READINGS:
        fail(f"usage: measure-frame.py <{'|'.join(READINGS)}> <frame> ...", 64)
    reading, arities = READINGS[argv[0]]
    if len(argv) - 1 not in arities:
        counts = " or ".join(str(arity) for arity in arities)
        fail(f"{argv[0]} reads {counts} arguments, not {len(argv) - 1}", 64)
    reading(argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
