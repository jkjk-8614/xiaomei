import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from document_attachments import document_archive_read, document_preview_image_bytes, document_preview_images, read_document_text
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def document_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return buffer.getvalue()


def text_pdf(text="Product plan"):
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=200)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 20 150 Td ({text}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


class DocumentAttachmentTests(unittest.TestCase):
    def test_xmind_picture_offsets_follow_topic_order_with_emoji_and_multiline_notes(self):
        sheets = [{"title": "📸 主图", "rootTopic": {"title": "相框", "children": {"attached": [
            {"title": "成品吸引", "notes": {"plain": {"content": "先看文字\n再看参考图"}}, "children": {"attached": [
                {"title": "", "image": {"src": "xap:resources/first.png"}},
                {"title": "", "image": {"src": "xap:resources/second.png"}},
            ]}},
            {"title": "SKU尺寸"},
        ]}}}]
        with tempfile.TemporaryDirectory(prefix="xiaomei-document-") as temporary:
            path = Path(temporary) / "策划.xmind"
            path.write_bytes(document_zip({"content.json": json.dumps(sheets, ensure_ascii=False), "resources/first.png": b"first", "resources/second.png": b"second"}))
            content = read_document_text(path, 12000)
            images, _ = document_preview_images(path)
            self.assertEqual([item["member"] for item in images], ["resources/first.png", "resources/second.png"])
            first, second = (item["after_char"] for item in images)
            self.assertLess(first, second)
            self.assertEqual(content[:first].splitlines()[-1].strip(), "- 未命名主题")
            self.assertEqual(content[:second].splitlines()[-1].strip(), "- 未命名主题")
            self.assertIn("先看文字\n再看参考图", content[:first])
            self.assertIn("SKU尺寸", content[second:])

    def test_xmind_embedded_pictures_keep_topic_labels_and_only_read_local_resources(self):
        png = io.BytesIO()
        Image.new("RGB", (4, 3), "red").save(png, "PNG")
        sheets = [{"title": "详情页", "rootTopic": {"title": "相框", "children": {"attached": [
            {"title": "主图参考", "image": {"src": "xap:resources/main.png"}, "notes": {"plain": {"content": "两张参考图\n保持顺序"}}},
            {"title": "外部图片", "image": {"src": "https://example.com/private.png"}},
            {"title": "越界图片", "image": {"src": "xap:../private.png"}},
        ]}}}]
        content = document_zip({"content.json": json.dumps(sheets, ensure_ascii=False), "resources/main.png": png.getvalue(), "resources/extra.png": png.getvalue()})
        with tempfile.TemporaryDirectory(prefix="xiaomei-document-") as temporary:
            path = Path(temporary) / "策划.xmind"
            path.write_bytes(content)
            images, truncated = document_preview_images(path)
            self.assertFalse(truncated)
            self.assertEqual([image["title"] for image in images], ["详情页 › 相框 › 主图参考", "文档图片：extra.png"])
            preview_text = read_document_text(path, 12000)
            self.assertEqual(preview_text[:images[0]["after_char"]].splitlines()[-1].strip(), "- 主图参考")
            self.assertIn("两张参考图\n保持顺序", preview_text[images[0]["after_char"]:])
            data, media_type = document_preview_image_bytes(path, 0)
            self.assertEqual(media_type, "image/jpeg")
            self.assertEqual(Image.open(io.BytesIO(data)).size, (4, 3))
            with self.assertRaises(IndexError):
                document_preview_image_bytes(path, 2)

    def test_legacy_xmind_image_and_office_media(self):
        xml = '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xhtml="http://www.w3.org/1999/xhtml"><sheet><title>主图</title><topic><title>实拍图</title><xhtml:img xhtml:src="xap:resources/photo.png"/></topic></sheet></xmap-content>'
        with tempfile.TemporaryDirectory(prefix="xiaomei-document-") as temporary:
            path = Path(temporary) / "旧版.xmind"
            path.write_bytes(document_zip({"content.xml": xml, "resources/photo.png": b"test"}))
            self.assertEqual(document_preview_images(path)[0][0]["title"], "主图 › 实拍图")
            for ext, member in [("docx", "word/media/image1.png"), ("pptx", "ppt/media/image1.png"), ("xlsx", "xl/media/image1.png")]:
                with self.subTest(ext=ext):
                    path = Path(temporary) / ("策划." + ext)
                    path.write_bytes(document_zip({member: b"test"}))
                    self.assertEqual(document_preview_images(path)[0][0]["member"], member)

    def read(self, name, content, limit=12000):
        with tempfile.TemporaryDirectory(prefix="xiaomei-document-") as temporary:
            path = Path(temporary) / name
            path.write_bytes(content)
            return read_document_text(path, limit)

    def test_xmind_json_preserves_sheets_hierarchy_notes_and_order(self):
        sheets = [{"title": "详情页", "rootTopic": {"title": "相框", "children": {
            "attached": [{"title": "首屏", "notes": {"plain": {"content": "保留标题"}}, "children": {"attached": [{"title": "材质"}]}}, {"title": "SKU", "labels": ["原木", "白色"]}],
            "detached": [{"title": "注意事项"}],
        }}}, {"title": "主图", "rootTopic": {"title": "主卖点"}}]
        result = self.read("策划.xmind", document_zip({"content.json": json.dumps(sheets, ensure_ascii=False)}))
        self.assertIn("工作表：详情页\n- 相框\n  - 首屏\n    备注：保留标题\n    - 材质", result)
        self.assertLess(result.index("首屏"), result.index("SKU"))
        self.assertLess(result.index("SKU"), result.index("注意事项"))
        self.assertIn("标签：原木、白色", result)
        self.assertIn("工作表：主图\n- 主卖点", result)

    def test_xmind_legacy_xml_and_docx_paragraphs(self):
        xml = '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"><sheet><title>策划</title><topic><title>相框</title><notes><plain>尺寸准确</plain></notes><children><topics type="attached"><topic><title>卖点</title></topic></topics></children></topic></sheet></xmap-content>'
        result = self.read("旧版.xmind", document_zip({"content.xml": xml}))
        self.assertIn("- 相框\n  备注：尺寸准确\n  - 卖点", result)
        docx = '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>商品标题</w:t></w:r><w:r><w:t>完整保留</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>SKU A</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
        self.assertEqual(self.read("WPS策划.docx", document_zip({"word/document.xml": docx})), "商品标题完整保留\nSKU A")

    def test_pptx_numeric_page_order_and_pdf_text(self):
        slide = lambda value: f'<a:root xmlns:a="urn:drawing"><a:p><a:r><a:t>{value}</a:t></a:r></a:p></a:root>'
        result = self.read("策划.pptx", document_zip({"ppt/slides/slide10.xml": slide("第十屏"), "ppt/slides/slide2.xml": slide("第二屏")}))
        self.assertLess(result.index("第二屏"), result.index("第十屏"))
        self.assertIn("Product plan", self.read("策划.pdf", text_pdf()))

    def test_pptx_uses_saved_presentation_order_after_rearranging_slides(self):
        presentation = '<p:presentation xmlns:p="urn:powerpoint" xmlns:r="urn:rels"><p:sldIdLst><p:sldId id="2" r:id="r2"/><p:sldId id="1" r:id="r1"/></p:sldIdLst></p:presentation>'
        relationships = '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>'
        slide = lambda text: f'<a:root xmlns:a="urn:drawing"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></a:root>'
        result = self.read("调整顺序.pptx", document_zip({"ppt/presentation.xml": presentation, "ppt/_rels/presentation.xml.rels": relationships, "ppt/slides/slide1.xml": slide("材质介绍"), "ppt/slides/slide2.xml": slide("封面卖点")}))
        self.assertLess(result.index("封面卖点"), result.index("材质介绍"))

    def test_native_formats_scan_only_pdf_and_corrupt_files_fail_clearly(self):
        for ext, target in [("wps", "docx"), ("et", "xlsx"), ("dps", "pptx"), ("doc", "docx"), ("xls", "xlsx"), ("ppt", "pptx")]:
            with self.subTest(ext=ext), self.assertRaisesRegex(ValueError, target):
                self.read("策划." + ext, b"legacy binary")
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        blank = io.BytesIO()
        writer.write(blank)
        with self.assertRaisesRegex(ValueError, "未读取到文字"):
            self.read("扫描.pdf", blank.getvalue())
        with self.assertRaises(zipfile.BadZipFile):
            self.read("损坏.xmind", b"not zip")

    def test_text_limit_and_large_archive_member(self):
        data = document_zip({"content.json": json.dumps([{"rootTopic": {"title": "很长" * 10000}}])})
        self.assertEqual(len(self.read("长策划.xmind", data, 121)), 121)
        with zipfile.ZipFile(io.BytesIO(document_zip({"content.json": "{}"}))) as archive:
            archive.getinfo("content.json").file_size = 33 * 1024 * 1024
            with self.assertRaisesRegex(ValueError, "过大"):
                document_archive_read(archive, "content.json")


if __name__ == "__main__":
    unittest.main()
