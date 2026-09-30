# python-pptx Guide

Use `python-pptx` for normal deck generation. Use direct OOXML editing for features `python-pptx` does not support cleanly, such as advanced masters, speaker notes, comments, animations, precise text autofit, complex bullets inherited from layouts, and chart XML repairs.

Use only Python packages and bundled command-line tools for generation; do not use Node-based generation libraries or package managers.

## Setup

Use Python 3.10+.

```bash
python3 -m pip install python-pptx Pillow defusedxml lxml
```

Run commands from the skill directory, or use absolute paths to the scripts under this skill. Always validate generated decks:

```bash
python3 scripts/office/validate.py output.pptx
```

## Basic Structure

```python
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt


out = Path("output.pptx")
prs = Presentation()
prs.slide_width = Inches(10)
prs.slide_height = Inches(5.625)  # 16:9
prs.core_properties.author = "通用 Skill 宿主"
prs.core_properties.title = "Presentation Title"

slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
slide.background.fill.solid()
slide.background.fill.fore_color.rgb = RGBColor(30, 39, 97)

title = slide.shapes.add_textbox(Inches(0.7), Inches(1.7), Inches(8.6), Inches(1.0))
p = title.text_frame.paragraphs[0]
p.text = "Presentation Title"
p.font.size = Pt(42)
p.font.bold = True
p.font.color.rgb = RGBColor(255, 255, 255)
p.alignment = PP_ALIGN.CENTER

prs.save(out)
```

## Slide Sizes

Use inches for layout math:

| Ratio | Width | Height |
|-------|-------|--------|
| 16:9 | 10" | 5.625" |
| 16:10 | 10" | 6.25" |
| 4:3 | 10" | 7.5" |
| Widescreen | 13.333" | 7.5" |

```python
prs.slide_width = Inches(10)
prs.slide_height = Inches(5.625)
```

## Text

```python
box = slide.shapes.add_textbox(Inches(0.6), Inches(0.5), Inches(8.8), Inches(0.7))
tf = box.text_frame
tf.margin_left = tf.margin_right = 0
tf.margin_top = tf.margin_bottom = 0

p = tf.paragraphs[0]
p.text = "Section Title"
p.font.name = "Aptos Display"
p.font.size = Pt(34)
p.font.bold = True
p.font.color.rgb = RGBColor(31, 41, 55)
p.alignment = PP_ALIGN.LEFT
```

For multi-paragraph content, create separate paragraphs. Do not join unrelated items with `\n`.

```python
tf.clear()
for idx, text in enumerate(["First point", "Second point", "Third point"]):
    p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
    p.text = text
    p.font.size = Pt(16)
```

## Bullets and Numbering

`python-pptx` does not provide a stable high-level bullet API for blank text boxes. If a template placeholder already has bullet formatting, prefer using that placeholder. For from-scratch blank text boxes, add list formatting with OOXML.

```python
from pptx.oxml.xmlchemy import OxmlElement


def _clear_list_style(paragraph) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    for child in list(pPr):
        if child.tag.endswith("}buNone") or child.tag.endswith("}buChar") or child.tag.endswith("}buAutoNum"):
            pPr.remove(child)


def set_bullet(paragraph, char="•", margin=342900, indent=-171450) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    _clear_list_style(paragraph)
    pPr.set("marL", str(margin))
    pPr.set("indent", str(indent))
    bu = OxmlElement("a:buChar")
    bu.set("char", char)
    pPr.insert(0, bu)


def set_numbered(paragraph, start_at=1, margin=342900, indent=-171450) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    _clear_list_style(paragraph)
    pPr.set("marL", str(margin))
    pPr.set("indent", str(indent))
    bu = OxmlElement("a:buAutoNum")
    bu.set("type", "arabicPeriod")
    if start_at != 1:
        bu.set("startAt", str(start_at))
    pPr.insert(0, bu)
```

Use bullets in list properties, not as text content:

```python
tf.clear()
for idx, text in enumerate(["Plan the deck", "Build slides", "Validate output"]):
    p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
    p.text = text
    p.font.size = Pt(16)
    set_bullet(p)
```

## Shapes

```python
card = slide.shapes.add_shape(
    MSO_SHAPE.RECTANGLE,
    Inches(0.6), Inches(1.2), Inches(4.0), Inches(3.5),
)
card.fill.solid()
card.fill.fore_color.rgb = RGBColor(255, 255, 255)
card.line.color.rgb = RGBColor(226, 232, 240)

accent = slide.shapes.add_shape(
    MSO_SHAPE.OVAL,
    Inches(8.4), Inches(0.55), Inches(0.45), Inches(0.45),
)
accent.fill.solid()
accent.fill.fore_color.rgb = RGBColor(249, 97, 103)
accent.line.fill.background()
```

`python-pptx` has limited support for shadows, gradients, advanced transparency, and precise rounded-corner behavior. Use solid fills first. For gradients, create a bitmap background and insert it as a full-slide image.

## Images and Icons

Use local image files. Do not rely on Node icon packages. For icons, use an existing image asset, a generated PNG/SVG file, or a Python icon source that is already available.

```python
slide.shapes.add_picture(
    "image.png",
    Inches(5.5), Inches(1.0),
    width=Inches(3.6),
)
```

To preserve aspect ratio manually:

```python
from PIL import Image


def image_size_for_height(path: str, height_in: float) -> tuple[float, float]:
    with Image.open(path) as img:
        ratio = img.width / img.height
    return height_in * ratio, height_in


w, h = image_size_for_height("image.png", 3.0)
slide.shapes.add_picture("image.png", Inches(1.0), Inches(1.2), width=Inches(w), height=Inches(h))
```

## Tables

```python
table_shape = slide.shapes.add_table(
    rows=3, cols=2,
    left=Inches(0.8), top=Inches(1.2),
    width=Inches(8.4), height=Inches(1.8),
)
table = table_shape.table

headers = ["Area", "Path"]
for col, text in enumerate(headers):
    cell = table.cell(0, col)
    cell.text = text
    cell.fill.solid()
    cell.fill.fore_color.rgb = RGBColor(30, 39, 97)
    p = cell.text_frame.paragraphs[0]
    p.font.bold = True
    p.font.color.rgb = RGBColor(255, 255, 255)
    p.font.size = Pt(12)

for row_idx, values in enumerate([("Create", "python-pptx"), ("Edit", "OOXML")], start=1):
    for col, text in enumerate(values):
        cell = table.cell(row_idx, col)
        cell.text = text
        cell.text_frame.paragraphs[0].font.size = Pt(12)
```

## Charts

Prefer chart images for polished generated decks. This avoids Office chart XML compatibility issues and gives better visual control.

```bash
python3 -m pip install matplotlib
```

```python
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(6, 3.5), dpi=200)
ax.bar(["Q1", "Q2", "Q3"], [4.5, 5.5, 6.2], color=["#0D9488", "#14B8A6", "#5EEAD4"])
ax.set_title("Quarterly Revenue")
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
fig.savefig("chart.png", transparent=True)
plt.close(fig)

slide.shapes.add_picture("chart.png", Inches(0.8), Inches(1.2), width=Inches(5.8))
```

If the user needs editable native PowerPoint charts, `python-pptx` can create them, but validate immediately. Some `python-pptx` chart outputs contain negative chart axis IDs that this skill's validator rejects. Repair those IDs after unpacking.

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

chart_data = CategoryChartData()
chart_data.categories = ["Q1", "Q2", "Q3"]
chart_data.add_series("Revenue", (4.5, 5.5, 6.2))
slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(0.8), Inches(1.1), Inches(5.5), Inches(3.6),
    chart_data,
)
```

After saving, validate:

```bash
python3 scripts/office/validate.py output.pptx
```

If validation reports negative `axId` or `crossAx` values:

```bash
python3 scripts/office/unpack.py output.pptx unpacked/
```

```python
from pathlib import Path
import re


def repair_negative_chart_axis_ids(unpacked_dir: str) -> None:
    root = Path(unpacked_dir)
    pattern = re.compile(r'(<c:(?:axId|crossAx)\b[^>]*\bval=")(-\d+)(")')

    def repl(match: re.Match[str]) -> str:
        value = int(match.group(2))
        return f"{match.group(1)}{value + (1 << 32)}{match.group(3)}"

    for path in root.glob("ppt/charts/*.xml"):
        text = path.read_text(encoding="utf-8")
        fixed = pattern.sub(repl, text)
        if fixed != text:
            path.write_text(fixed, encoding="utf-8")


repair_negative_chart_axis_ids("unpacked")
```

Then pack and validate:

```bash
python3 scripts/office/pack.py unpacked/ output.repaired.pptx --validate false
python3 scripts/office/validate.py output.repaired.pptx
```

## Layout Masters and Templates

For a from-scratch deck, use blank slides and consistent helper functions for title, subtitle, cards, and section dividers. For a branded or highly structured deck, start from an existing template and follow [editing.md](editing.md).

`python-pptx` can use existing slide layouts, but it does not provide full master editing. For master-level changes, unpack and edit OOXML directly.

## Validation Checklist

1. Save the deck.
2. Run `python3 scripts/office/validate.py output.pptx`.
3. Run `python3 -m markitdown output.pptx` if text extraction is needed.
4. Convert to images with LibreOffice and Poppler for visual QA when those tools are available.
5. Inspect for overlap, overflow, low contrast, inconsistent margins, and placeholder text.

## Common Pitfalls

- Use Python 3.10+; `validate.py` uses modern Python syntax.
- Use `python3`, not bare `python`, unless `python` is known to point to Python 3.10+.
- Use `RGBColor(255, 0, 0)` for colors, not `"#FF0000"`.
- Do not put bullet glyphs inside the text itself. Use layout inheritance or OOXML list properties.
- Do not rely on native editable charts without validation; repair negative axis IDs if needed.
- Keep every slide visually intentional: use images, charts, icons, shapes, or strong layout, not plain title plus bullets.
