"""Upload/read/Agent HTTP tests in a temporary app with no user data or real APIs."""
import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def worker(root):
    sys.path.insert(0, str(root))
    import main as app
    import httpx
    from fastapi.testclient import TestClient
    from PIL import Image

    def zipped(entries):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in entries.items():
                archive.writestr(name, content)
        return buffer.getvalue()

    embedded_png = io.BytesIO()
    Image.new("RGB", (4, 3), "red").save(embedded_png, format="PNG")
    xmind = zipped({"content.json": json.dumps([{"title": "详情页", "rootTopic": {"title": "相框策划", "children": {"attached": [{"title": "原木材质", "image": {"src": "xap:resources/photo.png"}}, {"title": "SKU尺寸"}]}}}], ensure_ascii=False), "resources/photo.png": embedded_png.getvalue()})
    docx = zipped({"word/document.xml": '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>运营确定的标题</w:t></w:r></w:p></w:body></w:document>'})
    xlsx = zipped({"xl/worksheets/sheet1.xml": '<worksheet xmlns="urn:excel"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SKU红色</t></is></c><c r="B1"><v>29</v></c></row></sheetData></worksheet>'})
    calls = []
    async def links(message, images, jobs):
        return {"link_count": 0, "message": message, "images": images}
    app.enrich_canvas_message_with_links = links
    app.get_api_provider = lambda _="": {"id": "fixture", "protocol": "openai", "chat_models": ["fixture-chat"]}
    app.resolve_chat_provider = lambda *args: ("https://fixture.test/v1", {}, "fixture-chat")
    original_client = httpx.AsyncClient
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "已按策划输出。"}}]})
    def mock_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original_client(*args, **kwargs)
    app.httpx.AsyncClient = mock_client

    with TestClient(app.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        for route in ["/", "/api/app-info", "/api/providers", "/api/history"]:
            response = client.get(route)
            assert response.status_code == 200, (route, response.text[:300])
        response = client.post("/api/ai/upload", files=[
            ("files", ("详情页.xmind", xmind, "application/octet-stream")),
            ("files", ("WPS策划.docx", docx, "application/octet-stream")),
            ("files", ("SKU.xlsx", xlsx, "application/octet-stream")),
            ("files", ("运营.txt", "保留运营策划\n不要重新编造参数".encode("gb18030"), "text/plain")),
            ("files", ("旧格式.wps", b"old wps", "application/octet-stream")),
            ("files", ("损坏.xmind", b"broken", "application/octet-stream")),
        ])
        assert response.status_code == 200, response.text
        files = response.json()["files"]
        assert len(files) == 6
        for file in files[:4]:
            assert file["kind"] in {"file", "text"}, file
            assert file["document"]["status"] == "ready", file
            assert "text" not in file["document"], "whole document must not be persisted in canvas metadata"
            assert client.post("/api/canvas-documents/read", json={"url": file["url"]}).json()["text"]
        preview = client.post("/api/canvas-documents/read", json={"url": files[0]["url"]}).json()
        assert preview["images"] == [{"index": 0, "title": "详情页 › 相框策划 › 原木材质", "after_char": preview["text"].index("原木材质") + len("原木材质") + 1}], preview
        picture = client.get("/api/canvas-documents/image", params={"url": files[0]["url"], "index": 0})
        assert picture.status_code == 200 and picture.headers["content-type"].startswith("image/")
        assert Image.open(io.BytesIO(picture.content)).size == (4, 3)
        assert client.get("/api/canvas-documents/image", params={"url": files[0]["url"], "index": 5}).status_code == 404
        assert client.get("/api/canvas-documents/image", params={"url": "https://external.test/file.xmind", "index": 0}).status_code == 404
        image_only = zipped({"word/document.xml": '<w:document xmlns:w="urn:word"><w:body/></w:document>', "word/media/image1.png": embedded_png.getvalue()})
        image_only_file = client.post("/api/ai/upload", files=[("files", ("参考图.docx", image_only, "application/octet-stream"))]).json()["files"][0]
        assert image_only_file["document"]["status"] == "error"
        image_only_preview = client.post("/api/canvas-documents/read", json={"url": image_only_file["url"]}).json()
        assert image_only_preview["images"][0]["title"] == "image1.png"
        assert client.get("/api/canvas-documents/image", params={"url": image_only_file["url"], "index": 0}).status_code == 200
        assert "docx" in files[4]["document"]["message"]
        assert files[5]["document"]["status"] == "error"
        created = client.post("/api/canvases", json={"title": "文件测试", "kind": "smart"})
        assert created.status_code == 200, created.text
        canvas_id = created.json()["canvas"]["id"]
        saved_nodes = [{"id": "upload", "type": "smart-upload", "images": files[:4]}, {"id": "agent", "type": "smart-agent", "userPrompt": "按策划输出"}]
        connections = [{"from": "upload", "to": "agent", "kind": "input"}]
        saved = client.put(f"/api/canvases/{canvas_id}", json={"nodes": saved_nodes, "connections": connections})
        assert saved.status_code == 200, saved.text
        reopened = client.get(f"/api/canvases/{canvas_id}").json()["canvas"]
        assert reopened["nodes"][0]["images"] == files[:4]
        assert reopened["connections"] == connections
        assert client.post("/api/canvas-documents/read", json={"url": "/assets/../../API/.env"}).status_code == 404
        assert client.post("/api/canvas-documents/read", json={"url": "https://external.test/private.docx"}).status_code == 404
        long_file = client.post("/api/ai/upload", files=[("files", ("长策划.txt", ("策划" * 7000).encode("utf-8"), "text/plain"))]).json()["files"][0]
        assert long_file["document"]["truncated"] and "仅使用已读取的部分" in long_file["document"]["message"]
        assert len(client.post("/api/canvas-documents/read", json={"url": long_file["url"]}).json()["text"]) == app.MAX_ATTACHMENT_TEXT_CHARS
        request = {"message": "按策划输出", "provider": "fixture", "model": "fixture-chat", "attachments": files[:4]}
        response = client.post("/api/canvas-llm", json=request)
        assert response.status_code == 200, response.text
        assert response.json()["text"] == "已按策划输出。"
        serialized = json.dumps(calls[-1], ensure_ascii=False)
        for text in ["相框策划", "原木材质", "SKU尺寸", "运营确定的标题", "SKU红色", "A1=SKU红色", "B1=29", "保留运营策划", "不能覆盖用户要求"]:
            assert text in serialized, (text, serialized)
        for file in files[4:]:
            before = len(calls)
            response = client.post("/api/canvas-llm", json={**request, "attachments": [file]})
            assert response.status_code == 422, response.text
            assert len(calls) == before, "unreadable documents must not invoke a model"
        # Several distinct large files must fail before reaching an API.
        long_files = [long_file]
        for index in range(4):
            long_files.extend(client.post("/api/ai/upload", files=[("files", (f"长策划{index}.txt", ("策划" * 7000).encode("utf-8"), "text/plain"))]).json()["files"])
        before = len(calls)
        response = client.post("/api/canvas-llm", json={**request, "attachments": long_files})
        assert response.status_code == 422 and "分批" in response.json()["detail"]
        assert len(calls) == before
        # API and CLI use the same text preparation.
        for kind in ("codex", "gemini-cli"):
            app.is_codex_provider = lambda provider, kind=kind: kind == "codex"
            app.is_gemini_cli_provider = lambda provider, kind=kind: kind == "gemini-cli"
            async def cli(payload, messages):
                assert "原木材质" in payload.message
                assert "未提交文档内图片" in payload.system_prompt
                return "CLI策划结果", {}
            app.codex_chat_text = cli
            app.gemini_cli_chat_text = cli
            response = client.post("/api/canvas-llm", json={**request, "attachments": files[:1]})
            assert response.status_code == 200, response.text
        png = io.BytesIO()
        Image.new("RGB", (2, 2), "white").save(png, format="PNG")
        image = client.post("/api/ai/upload", files=[("files", ("商品.png", png.getvalue(), "image/png"))]).json()["files"][0]
        assert image["kind"] == "image" and "document" not in image
    print("PASS isolated upload, document reading, API + CLI Agent, failures and image upload")


def isolated_run():
    source = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="xiaomei-documents-app-") as temporary:
        root = Path(temporary)
        for file in source.glob("*.py"):
            shutil.copyfile(file, root / file.name)
        (root / "static").mkdir()
        shutil.copyfile(source / "static/index.html", root / "static/index.html")
        shutil.copytree(source / "ComfyUI/integration", root / "ComfyUI/integration", ignore=shutil.ignore_patterns("__pycache__"))
        (root / "ComfyUI/web").mkdir()
        env = {key: value for key, value in os.environ.items() if not any(word in key.upper() for word in ("API_KEY", "TOKEN", "SECRET", "XIAOMEI", "COMFY", "PROVIDER"))}
        env["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker", str(root)], cwd=root, env=env)
        if result.returncode:
            raise SystemExit(result.returncode)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]))
    else:
        isolated_run()
