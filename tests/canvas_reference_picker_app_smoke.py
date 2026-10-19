"""Check reference persistence and HTTP entry points in an isolated app copy."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def worker(root):
    sys.path.insert(0, str(root))
    import main
    from fastapi.testclient import TestClient

    providers = [{"id": "fixture", "protocol": "openai", "base_url": "https://fixture.invalid/v1",
                  "image_models": ["fixture-image"], "chat_models": ["fixture-chat"]}]

    async def capabilities(*args, **kwargs):
        return {"image_models": []}

    async def public_providers(*args, **kwargs):
        return providers

    main.detect_codex_image_capabilities = capabilities
    main.public_api_providers = public_providers
    references = [
        {"nodeId": "source", "imageIndex": index, "url": f"/assets/fixture-{name}.png",
         "name": name, "kind": "image", "mime_type": "image/png", "asset_ref_id": f"fixture-{name}",
         "asset_uris": {"fixture": f"asset://fixture-{name}"},
         "referenceId": f"fixture-{name}", "sourceImageId": f"fixture-{name}",
         "source": "canvas-picker", "manualAdded": True}
        for index, name in enumerate(["甲", "乙", "丙"])
    ]
    ordered_refs = [references[2], references[0], references[1]]
    order = [f"ref|{ref['referenceId']}" for ref in ordered_refs]
    nodes = [{"id": "source", "type": "smart-upload", "images": references}]
    for node_id, node_type in [("paint", "smart-paint"), ("video", "smart-paint"),
                               ("prompt", "smart-prompt"), ("agent", "smart-agent")]:
        nodes.append({"id": node_id, "type": node_type, "manualInputRefs": ordered_refs,
                      "inputRefOrder": order,
                      "runSettings": {"apiKind": "video" if node_id == "video" else "image"}})
    connections = [{"from": "source", "to": "prompt", "kind": "input"}]

    with TestClient(main.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        routes = ["/", "/api/app-info", "/api/providers", "/api/history", "/api/config",
                  "/static/smart-canvas.html", "/static/js/smart-canvas-reference-picker.js"]
        for route in routes:
            response = client.get(route)
            assert response.status_code == 200, (route, response.text[:300])
        config = client.get("/api/config").json()
        assert config["reference_image_limits"] == main.canvas_reference_image_limits(providers)
        assert client.get("/api/providers").json()["providers"] == providers
        html = client.get("/static/smart-canvas.html").text
        assert html.index("js/smart-canvas-reference-picker.js") < html.index("js/smart-canvas.js")
        assert "reference-picker=" in html

        created = client.post("/api/canvases", json={"title": "连续选图验收", "kind": "smart"})
        assert created.status_code == 200, created.text
        canvas_id = created.json()["canvas"]["id"]
        response = client.put(f"/api/canvases/{canvas_id}", json={
            "title": "连续选图验收", "nodes": nodes, "connections": connections,
            "viewport": {"x": 25, "y": -10, "scale": 0.65}})
        assert response.status_code == 200, response.text
        reopened = client.get(f"/api/canvases/{canvas_id}").json()["canvas"]
        for expected, actual in zip(nodes, reopened["nodes"], strict=True):
            assert {key: actual[key] for key in expected} == expected
        assert reopened["connections"] == connections
        assert reopened["viewport"] == {"x": 25, "y": -10, "scale": 0.65}

        changed = {**nodes[1], "manualInputRefs": ordered_refs[:2], "inputRefOrder": order[:2],
                   "blockedInputRefs": [order[2]]}
        response = client.patch(f"/api/canvases/{canvas_id}/nodes", json={"changes": [changed]})
        assert response.status_code == 200, response.text
        reopened = client.get(f"/api/canvases/{canvas_id}").json()["canvas"]
        actual = next(node for node in reopened["nodes"] if node["id"] == changed["id"])
        assert {key: actual[key] for key in changed} == changed
        assert reopened["connections"] == connections

        legacy = {"id": "legacy", "type": "smart-paint", "manualInputRefs": [
            {"nodeId": "source", "imageIndex": 0, "url": references[0]["url"]}],
            "inputRefOrder": ["source|0"]}
        response = client.patch(f"/api/canvases/{canvas_id}/nodes", json={"changes": [legacy]})
        assert response.status_code == 200, response.text
        reopened = client.get(f"/api/canvases/{canvas_id}").json()["canvas"]
        actual = next(node for node in reopened["nodes"] if node["id"] == "legacy")
        assert actual["manualInputRefs"] == legacy["manualInputRefs"]
        assert actual["inputRefOrder"] == legacy["inputRefOrder"]
    print("PASS: 7 HTTP entry points, dynamic model limits, four node targets, full and incremental saves, metadata/order, legacy references")


def isolated_run():
    source = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="xiaomei-reference-picker-app-") as temporary:
        root = Path(temporary)
        for file in source.glob("*.py"):
            shutil.copyfile(file, root / file.name)
        for relative in ["static/index.html", "static/smart-canvas.html", "static/js/smart-canvas-reference-picker.js"]:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)
        shutil.copytree(source / "ComfyUI/integration", root / "ComfyUI/integration",
                        ignore=shutil.ignore_patterns("__pycache__"))
        (root / "ComfyUI/web").mkdir()
        env = {key: value for key, value in os.environ.items()
               if not any(word in key.upper() for word in ("API_KEY", "TOKEN", "SECRET", "XIAOMEI", "COMFY", "PROVIDER"))}
        env["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker", str(root)],
                                cwd=root, env=env)
        if result.returncode:
            raise SystemExit(result.returncode)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]))
    else:
        isolated_run()
