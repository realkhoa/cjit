"""Generates the app icons for the web manifest.

Kept as a script rather than a checked-in binary blob nobody can regenerate: the
icons are a VS Code dark square with `C++` in the editor's accent blue, which is
exactly what the app looks like.

    python scripts/make-icons.py
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

BACKGROUND = (30, 30, 30)      # --vs-bg: the editor's dark background
ACCENT = (86, 156, 214)        # --vs-accent: the editor's blue
BORDER = (62, 62, 66)
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"


def font(size: int):
    """The best available monospace-ish font, scaled to the icon."""
    for name in ("consola.ttf", "cour.ttf", "DejaVuSansMono.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make(size: int, maskable: bool) -> Image.Image:
    """One icon. Maskable icons keep their content inside a safe circle."""
    image = Image.new("RGBA", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)

    if not maskable:
        # A rounded frame, so the icon reads as a tile rather than a square of paint.
        draw.rounded_rectangle(
            [(2, 2), (size - 3, size - 3)],
            radius=max(size // 8, 4),
            outline=BORDER,
            width=max(size // 32, 2),
        )

    # Maskable icons are cropped to a circle by the launcher: 60% is the safe zone.
    text = "C++"
    target = int(size * (0.42 if maskable else 0.62))
    chosen = font(target)
    box = draw.textbbox((0, 0), text, font=chosen)
    width, height = box[2] - box[0], box[3] - box[1]
    draw.text(
        ((size - width) / 2 - box[0], (size - height) / 2 - box[1]),
        text,
        font=chosen,
        fill=ACCENT,
    )
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, maskable in ((192, False), (512, False), (512, True)):
        name = f"icon-{size}{'-maskable' if maskable else ''}.png"
        make(size, maskable).save(OUT / name)
        print(f"wrote {OUT / name}")


if __name__ == "__main__":
    main()
