---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of \"Word doc\", \"word document\", \".docx\", or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a \"report\", \"memo\", \"letter\", \"template\", or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files.

## Quick Reference

| Task | Approach |
|------|----------|
| Read/analyze content | `pandoc` or unpack for raw XML |
| Create new document | Use `python-docx`; install with `python3 -m pip install python-docx defusedxml lxml` if missing |
| Edit existing document | Unpack → edit XML → repack - see Editing Existing Documents below |

Use Python 3.10+ for the helper scripts. Command examples use `python3`; if an environment only exposes `python`, confirm it points to Python 3.10+ before substituting it.
Run script commands from the skill directory, or use absolute paths to the scripts under this skill.

### Converting .doc to .docx

Legacy `.doc` files must be converted before editing:

```bash
python3 scripts/office/soffice.py --headless --convert-to docx document.doc
```

**Chinese content note**: `.doc` files created on Chinese Windows are often GBK-encoded internally. `scripts/office/soffice.py` automatically sets `LANG=zh_CN.UTF-8` / `LC_ALL=zh_CN.UTF-8` when the environment lacks a UTF-8 locale, so LibreOffice can decode CJK characters correctly during conversion. If Chinese text still appears garbled after conversion, verify that the `zh_CN.UTF-8` locale is installed on the system:

```bash
# Linux: install the locale if missing
locale -a | grep zh_CN          # check availability
sudo locale-gen zh_CN.UTF-8     # install if absent (Debian/Ubuntu)
```

macOS always has full Unicode locale support, so no additional setup is needed there.

### Reading Content

```bash
# Text extraction with tracked changes
pandoc --track-changes=all document.docx -o output.md

# Raw XML access
python3 scripts/office/unpack.py document.docx unpacked/
```

### Converting to Images

```bash
python3 scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

### Accepting Tracked Changes

To produce a clean document with all tracked changes accepted (requires LibreOffice):

```bash
python3 scripts/accept_changes.py input.docx output.docx
```

---

## Creating New Documents

Generate .docx files with Python, then validate. If required packages are missing, install them in the active Python environment:

```bash
python3 -m pip install python-docx defusedxml lxml
```

Use `python-docx` for normal document generation. For features it does not support cleanly (advanced TOC fields, comments, tracked changes, complex numbering, custom XML parts), create the base document with `python-docx`, then unpack → edit OOXML directly → pack/validate.

### Setup

```python
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn


def set_word_compatibility_defaults(doc: Document) -> None:
    """Set OOXML defaults that python-docx may omit but validators expect."""
    settings = doc.settings.element
    zoom = settings.find(qn("w:zoom"))
    if zoom is None:
        zoom = OxmlElement("w:zoom")
        settings.insert(0, zoom)
    zoom.set(qn("w:percent"), "100")


doc = Document()
set_word_compatibility_defaults(doc)
section = doc.sections[0]
section.page_width = Inches(8.5)
section.page_height = Inches(11)
section.top_margin = section.bottom_margin = Inches(1)
section.left_margin = section.right_margin = Inches(1)

doc.add_heading("Document Title", level=1)
p = doc.add_paragraph()
run = p.add_run("Body text")
run.font.name = "Arial"
run.font.size = Pt(11)

doc.save("doc.docx")
```

### Validation
After creating the file, validate it. If validation fails, unpack, fix the XML, and repack.
```bash
python3 scripts/office/validate.py doc.docx
```

### Page Size

```python
from docx.shared import Inches
from docx.enum.section import WD_ORIENT

section = doc.sections[0]

# US Letter portrait, 1" margins
section.page_width = Inches(8.5)
section.page_height = Inches(11)
section.top_margin = section.bottom_margin = Inches(1)
section.left_margin = section.right_margin = Inches(1)

# Landscape: set orientation, then set dimensions explicitly
section.orientation = WD_ORIENT.LANDSCAPE
section.page_width = Inches(11)
section.page_height = Inches(8.5)
```

**Common page sizes (DXA units, 1440 DXA = 1 inch):**

| Paper | Width | Height | Content Width (1" margins) |
|-------|-------|--------|---------------------------|
| US Letter | 12,240 | 15,840 | 9,360 |
| A4 (default) | 11,906 | 16,838 | 9,026 |

When precise OOXML sizes are needed, use the DXA values above in `word/document.xml` after unpacking.

### Styles (Override Built-in Headings)

Use Arial as the default font (universally supported). Keep titles black for readability.

```python
from docx.shared import Pt
from docx.enum.style import WD_STYLE_TYPE

styles = doc.styles
styles["Normal"].font.name = "Arial"
styles["Normal"].font.size = Pt(11)

h1 = styles["Heading 1"]
h1.font.name = "Arial"
h1.font.size = Pt(16)
h1.font.bold = True

h2 = styles["Heading 2"]
h2.font.name = "Arial"
h2.font.size = Pt(14)
h2.font.bold = True

doc.add_paragraph("Section title", style="Heading 1")
```

### Lists

Use Word list styles for normal bullets and numbers. Do not manually insert unicode bullets unless the user explicitly asks for plain text glyphs.

```python
doc.add_paragraph("Bullet item", style="List Bullet")
doc.add_paragraph("Another bullet", style="List Bullet")
doc.add_paragraph("First numbered item", style="List Number")
doc.add_paragraph("Second numbered item", style="List Number")
```

For custom numbering, generate the base document, unpack it, edit `word/numbering.xml` and paragraph `<w:numPr>` directly, then pack/validate.

### Tables

Set table style and explicit column widths for predictable rendering.

```python
from docx.shared import Inches
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT

table = doc.add_table(rows=1, cols=2)
table.style = "Table Grid"
table.alignment = WD_TABLE_ALIGNMENT.CENTER
table.autofit = False

widths = [Inches(4.0), Inches(2.5)]
for row in table.rows:
    for idx, cell in enumerate(row.cells):
        cell.width = widths[idx]
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER

hdr = table.rows[0].cells
hdr[0].text = "Metric"
hdr[1].text = "Value"

row = table.add_row().cells
row[0].text = "Revenue"
row[1].text = "$10,000"
```

**Width rules:**
- Prefer explicit inch widths in `python-docx`
- For platform-sensitive output, unpack and confirm table `<w:tblW>` and cell `<w:tcW>` are explicit DXA widths
- Cell margins reduce content area; they do not add to cell width
- For full-width tables: use content width (page width minus left and right margins)

### Images

```python
from docx.shared import Inches

doc.add_picture("image.png", width=Inches(3.0))

# For inline placement with a caption:
p = doc.add_paragraph()
r = p.add_run()
r.add_picture("image.png", width=Inches(2.0))
doc.add_paragraph("Figure 1. Caption", style="Caption")
```

If alt text, complex wrapping, or anchored positioning is required, add the image with `python-docx`, unpack, then edit the DrawingML in `word/document.xml`.

### Page Breaks

```python
doc.add_page_break()

p = doc.add_paragraph("New page section")
p.paragraph_format.page_break_before = True
```

### Table of Contents

`python-docx` does not provide a high-level TOC API. Use real Word heading styles (`Heading 1`, `Heading 2`, etc.) so Word/LibreOffice can build a TOC later. If a TOC field must be present in the file, create the base document, unpack, and insert the field code OOXML manually before packing.

### Headers/Footers

```python
section = doc.sections[0]
section.header.paragraphs[0].text = "Header text"

footer_p = section.footer.paragraphs[0]
footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
footer_p.text = "Confidential"
```

### Critical Rules for python-docx and OOXML

- **Use Python 3.10+** for the included helper scripts and validation tools
- **Install Python packages when missing**: `python3 -m pip install python-docx defusedxml lxml`
- **Call `set_word_compatibility_defaults(doc)`** before saving generated documents so `validate.py` does not fail on missing OOXML defaults
- **Set page size and margins explicitly** for generated deliverables
- **Use separate paragraphs** instead of embedding `\n` in one paragraph
- **Use Word list styles** for ordinary bullets/numbers; use OOXML numbering for custom list behavior
- **Use real heading styles** (`Heading 1`, `Heading 2`, etc.) for document structure and future TOCs
- **Set table and cell widths deliberately** when layout matters
- **Set image display dimensions** with `width` and/or `height`
- **Do not use `python-docx` for tracked changes or comments**; use the OOXML workflow below
- **Always validate after generation or OOXML edits** with `python3 scripts/office/validate.py`

---

## Editing Existing Documents

**Follow all 3 steps in order.**

### Step 1: Unpack
```bash
python3 scripts/office/unpack.py document.docx unpacked/
```
Extracts XML, pretty-prints, merges adjacent runs, and converts smart quotes to XML entities (`&#x201C;` etc.) so they survive editing. Use `--merge-runs false` to skip run merging.

### Step 2: Edit XML

Edit files in `unpacked/word/`. See XML Reference below for patterns.

**Use "Claude" as the author** for tracked changes and comments, unless the user explicitly requests use of a different name.

**Use the Edit tool directly for string replacement. Do not write Python scripts.** Scripts introduce unnecessary complexity. The Edit tool shows exactly what is being replaced.

**CRITICAL: Use smart quotes for new content.** When adding text with apostrophes or quotes, use XML entities to produce smart quotes:
```xml
<!-- Use these entities for professional typography -->
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```
| Entity | Character |
|--------|-----------|
| `&#x2018;` | ‘ (left single) |
| `&#x2019;` | ’ (right single / apostrophe) |
| `&#x201C;` | “ (left double) |
| `&#x201D;` | ” (right double) |

**Adding comments:** Use `comment.py` to handle boilerplate across multiple XML files (text must be pre-escaped XML):
```bash
python3 scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"
python3 scripts/comment.py unpacked/ 1 "Reply text" --parent 0  # reply to comment 0
python3 scripts/comment.py unpacked/ 0 "Text" --author "Custom Author"  # custom author name
```
Then add markers to document.xml (see Comments in XML Reference).

### Step 3: Pack
```bash
python3 scripts/office/pack.py unpacked/ output.docx --original document.docx
```
Validates with auto-repair, condenses XML, and creates DOCX. Use `--validate false` to skip.

**Auto-repair will fix:**
- `durableId` >= 0x7FFFFFFF (regenerates valid ID)
- Missing `xml:space="preserve"` on `<w:t>` with whitespace

**Auto-repair won't fix:**
- Malformed XML, invalid element nesting, missing relationships, schema violations

### Common Pitfalls

- **Replace entire `<w:r>` elements**: When adding tracked changes, replace the whole `<w:r>...</w:r>` block with `<w:del>...<w:ins>...` as siblings. Don't inject tracked change tags inside a run.
- **Preserve `<w:rPr>` formatting**: Copy the original run's `<w:rPr>` block into your tracked change runs to maintain bold, font size, etc.

---

## XML Reference

### Schema Compliance

- **Element order in `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`, `<w:ind>`, `<w:jc>`, `<w:rPr>` last
- **Whitespace**: Add `xml:space="preserve"` to `<w:t>` with leading/trailing spaces
- **RSIDs**: Must be 8-digit hex (e.g., `00AB1234`)

### Tracked Changes

**Insertion:**
```xml
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

**Deletion:**
```xml
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Inside `<w:del>`**: Use `<w:delText>` instead of `<w:t>`, and `<w:delInstrText>` instead of `<w:instrText>`.

**Minimal edits** - only mark what changes:
```xml
<!-- Change "30 days" to "60 days" -->
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Claude" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Claude" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
```

**Deleting entire paragraphs/list items** - when removing ALL content from a paragraph, also mark the paragraph mark as deleted so it merges with the next paragraph. Add `<w:del/>` inside `<w:pPr><w:rPr>`:
```xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- list numbering if present -->
    <w:rPr>
      <w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
```
Without the `<w:del/>` in `<w:pPr><w:rPr>`, accepting changes leaves an empty paragraph/list item.

**Rejecting another author's insertion** - nest deletion inside their insertion:
```xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="Claude" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
```

**Restoring another author's deletion** - add insertion after (don't modify their deletion):
```xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="Claude" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
```

### Comments

After running `comment.py` (see Step 2), add markers to document.xml. For replies, use `--parent` flag and nest markers inside the parent's.

**CRITICAL: `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings of `<w:r>`, never inside `<w:r>`.**

```xml
<!-- Comment markers are direct children of w:p, never inside w:r -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>

<!-- Comment 0 with reply 1 nested inside -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>text</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

### Images

1. Add image file to `word/media/`
2. Add relationship to `word/_rels/document.xml.rels`:
```xml
<Relationship Id="rId5" Type=".../image" Target="media/image1.png"/>
```
3. Add content type to `[Content_Types].xml`:
```xml
<Default Extension="png" ContentType="image/png"/>
```
4. Reference in document.xml:
```xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMUs: 914400 = 1 inch -->
    <a:graphic>
      <a:graphicData uri=".../picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

---

## Dependencies

- **pandoc**: Text extraction
- **Python 3.10+**: Required by the helper scripts
- **python-docx**: New documents. If missing, run `python3 -m pip install python-docx`
- **defusedxml + lxml**: XML editing and validation scripts. If missing, run `python3 -m pip install defusedxml lxml`
- **LibreOffice**: PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- **Poppler**: `pdftoppm` for images
