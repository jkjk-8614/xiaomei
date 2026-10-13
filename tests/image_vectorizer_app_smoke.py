"""Exercise the integrated routes in a clean copy without reading user data."""
import os
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

import requests
from PIL import Image, ImageDraw


source = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="xiaomei-vector-smoke-") as temporary:
    root = Path(temporary).resolve()
    for file in source.glob("*.py"):
        shutil.copyfile(file, root / file.name)
    (root / "static").mkdir()
    shutil.copyfile(source / "static/index.html", root / "static/index.html")
    shutil.copytree(source / "ComfyUI/integration", root / "ComfyUI/integration", ignore=shutil.ignore_patterns("__pycache__"))
    (root / "ComfyUI/web").mkdir()
    if (source / "VERSION").exists():
        shutil.copyfile(source / "VERSION", root / "VERSION")
    # Exercise the configured image space outside assets/, where files use the
    # storage route's explicit MIME helper rather than StaticFiles guessing.
    image_space = root / "用户图片空间"
    for folder in ("上传素材", "生成素材", "本地素材"):
        (image_space / folder).mkdir(parents=True)
    (root / "data").mkdir()
    (root / "data/storage_settings.json").write_text(json.dumps({
        "version": 2, "image_space": str(image_space),
        "upload": str(image_space / "上传素材"), "generated": str(image_space / "生成素材"),
        "local": str(image_space / "本地素材"), "legacy_dirs": {},
    }, ensure_ascii=False), encoding="utf-8")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {key:value for key,value in os.environ.items() if not any(word in key.upper() for word in ("API_KEY", "TOKEN", "SECRET", "XIAOMEI", "COMFY", "PROVIDER"))}
    env.update(XIAOMEI_CANVAS_PORT=str(port), PYTHONIOENCODING="utf-8")
    with (root / "smoke.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([sys.executable, str(root / "main.py")], cwd=root, env=env, stdout=log, stderr=log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            base = f"http://127.0.0.1:{port}"
            client = requests.Session()
            for _ in range(150):
                if process.poll() is not None:
                    raise RuntimeError((root / "smoke.log").read_text(encoding="utf-8")[-5000:])
                try:
                    if client.get(base + "/api/app-info", timeout=1).status_code == 200:
                        break
                except requests.RequestException:
                    pass
                time.sleep(.2)
            else:
                raise RuntimeError("Clean application startup timed out")
            for route in ("/", "/api/app-info", "/api/providers", "/api/history", "/api/image-vectorizer/status"):
                response = client.get(base + route, timeout=5)
                assert response.status_code == 200, (route, response.text)
                print("200", route)
            fixture = root / "assets" / "矢量原图.png"
            fixture.parent.mkdir(exist_ok=True)
            image = Image.new("RGBA", (64, 48), (0, 0, 0, 0))
            ImageDraw.Draw(image).rectangle((10, 10, 54, 38), fill="#25a084")
            image.save(fixture)
            response = client.post(base + "/api/image/vectorize", json={"source_url":"/assets/矢量原图.png", "name":"矢量原图.png", "preset":"logo"}, timeout=20)
            assert response.status_code == 200, response.text
            result = response.json()
            assert result["url"].startswith("/api/storage-files/generated/"), result["url"]
            preview = client.get(base + result["url"], timeout=5)
            assert preview.status_code == 200, preview.text
            svg = ET.fromstring(preview.content)
            assert svg.tag == "{http://www.w3.org/2000/svg}svg"
            assert svg.get("viewBox") == "0 0 64 48"
            assert list(svg.iter("{http://www.w3.org/2000/svg}path"))
            assert "image/svg+xml" in preview.headers["content-type"]
            # Decode the served SVG in Chromium too: HTTP 200 and XML parsing
            # alone do not catch a browser rejecting the wrong Content-Type.
            probe = subprocess.run(["node", "-e", r'''
                const {chromium}=require(process.argv[1]);
                (async()=>{
                    const browser=await chromium.launch({channel:'msedge',headless:true});
                    try {
                        const page=await browser.newPage();
                        await page.goto(process.argv[2]+'/api/app-info');
                        const size=await page.evaluate(url=>new Promise((resolve,reject)=>{
                            const image=new Image();
                            const timer=setTimeout(()=>reject(new Error('SVG preview timeout')),10000);
                            image.onload=()=>{clearTimeout(timer);resolve([image.naturalWidth,image.naturalHeight]);};
                            image.onerror=()=>{clearTimeout(timer);reject(new Error('SVG preview decode failed'));};
                            image.src=url;
                        }),process.argv[3]);
                        if(size[0]!==64||size[1]!==48)throw new Error(JSON.stringify(size));
                        console.log('Chromium decoded storage SVG',JSON.stringify(size));
                    } finally {await browser.close();}
                })().catch(error=>{console.error(error);process.exitCode=1;});
            ''', str(source / "tools/commerce-analysis/node_modules/playwright"), base, result["url"]],
                capture_output=True, text=True, encoding="utf-8", timeout=25,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            assert probe.returncode == 0, probe.stdout + probe.stderr
            print(probe.stdout.strip())
            status = client.get(base + "/api/image-vectorizer/status", timeout=5).json()
            assert status == {"vtracer_ready": True, "paid_api": False}
            assert not result["paid_api"]
            print("200 POST /api/image/vectorize; SVG served with paths")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
