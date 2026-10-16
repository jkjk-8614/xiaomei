import io
import json
import sqlite3
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from fastapi.testclient import TestClient

import inspiration_library as catalog


class InspirationLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        app = FastAPI()
        self.host = types.SimpleNamespace(DATA_DIR=self.temp.name)
        catalog.install_inspiration_library(app, self.host)
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_sync_filter_favorite_and_failed_refresh_preserves_cases(self):
        headings = ["uuid", "public", "title", "author", "tags", "model_tags", "catalog", "imgs", "prompt_origin"]
        image = [headings, ["abc123", True, "护肤品主图", "作者甲", ["电商", "护肤"], ["Nano Banana Pro"], "商品主图", [["预览图.webp", 800, 800]], "在白色背景中展示商品"]]
        video = [headings, ["vid123", True, "开箱视频", "作者乙", ["开箱"], ["Seedance 2.0"], "广告视频", [["预览图.webp", 800, 800]], "商品开箱镜头"]]

        def fetch(url, limit=9_000_000):
            return json.dumps(image if "image_prompt" in url else video, ensure_ascii=False)

        with patch.object(catalog, "_fetch", side_effect=fetch):
            response = self.client.post("/api/inspiration/sources/leaderai/sync")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["item_count"], 2)

        result = self.client.get("/api/inspiration/cases", params={"kind": "image", "model": "Nano Banana", "q": "护肤"}).json()
        self.assertEqual(result["total"], 1)
        self.assertNotIn("prompt", result["cases"][0])
        case_id = result["cases"][0]["id"]
        detail = self.client.get(f"/api/inspiration/cases/{case_id}").json()["case"]
        self.assertEqual(detail["prompt"], "在白色背景中展示商品")
        self.assertEqual(self.client.patch(f"/api/inspiration/cases/{case_id}/favorite", json={"favorite": True}).status_code, 200)
        self.assertEqual(self.client.get("/api/inspiration/cases", params={"favorites": "true"}).json()["total"], 1)

        with patch.object(catalog, "_fetch", side_effect=RuntimeError("来源暂时不可用")):
            failed = self.client.post("/api/inspiration/sources/leaderai/sync")
        self.assertEqual(failed.status_code, 502)
        self.assertEqual(self.client.get(f"/api/inspiration/cases/{case_id}").json()["case"]["favorite"], True)
        self.assertIn("来源暂时不可用", self.client.get("/api/inspiration/sources").json()["sources"][0]["error"])

    def test_unknown_source_rejected(self):
        self.assertEqual(self.client.post("/api/inspiration/sources/unknown/sync").status_code, 404)

    def test_h3_community_sync_provides_chinese_cards_posters_and_video(self):
        entry = {
            "slug": "product-reveal", "title": {"en": "Product reveal", "zh": "商品亮相"},
            "description": {"zh": "展示商品细节"}, "category": "product-commercial",
            "mode": "text-to-video", "duration": "10s", "prompt": "A detailed product reveal with camera movement.",
            "source": {"name": "@maker", "url": "https://x.com/maker/status/123"},
            "thumbnail": "https://media.beatapi.io/prompt-gallery/minimax-h3/product-reveal/poster-123.jpg",
            "video": "https://media.beatapi.io/prompt-gallery/minimax-h3/product-reveal/video-123.webm",
            "outputStatus": "source-verified",
        }
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("awesome-minimax-h3-prompts-main/prompts/product-reveal.json", json.dumps(entry))
        with patch.object(catalog, "_fetch_archive", return_value=archive.getvalue()):
            response = self.client.post("/api/inspiration/sources/minimax_h3_community/sync")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["item_count"], 1)
        card = self.client.get("/api/inspiration/cases", params={"kind": "video", "model": "MiniMax H3"}).json()["cases"][0]
        self.assertEqual(card["title"], "商品亮相")
        self.assertEqual(card["preview_url"], entry["thumbnail"])
        detail = self.client.get("/api/inspiration/cases/" + card["id"]).json()["case"]
        self.assertEqual(detail["video_url"], entry["video"])
        self.assertEqual(detail["source_url"], entry["source"]["url"])
        self.assertEqual(detail["prompt"], entry["prompt"])
        self.assertEqual(self.client.patch("/api/inspiration/cases/" + card["id"] + "/favorite", json={"favorite": True}).status_code, 200)
        with patch.object(catalog, "_fetch_archive", side_effect=RuntimeError("离线")):
            self.assertEqual(self.client.post("/api/inspiration/sources/minimax_h3_community/sync").status_code, 502)
        self.assertTrue(self.client.get("/api/inspiration/cases/" + card["id"]).json()["case"]["favorite"])

    def test_existing_index_gains_video_and_chinese_summary_columns(self):
        database = Path(self.temp.name) / "inspiration_library.sqlite3"
        with sqlite3.connect(database) as conn:
            conn.execute("ALTER TABLE cases DROP COLUMN video_url")
            conn.execute("ALTER TABLE cases DROP COLUMN summary_zh")
            conn.execute("UPDATE cases SET favorite=1 WHERE id='moke:worldbuilding-v17'")
        catalog.install_inspiration_library(FastAPI(), self.host)
        with sqlite3.connect(database) as conn:
            columns = {column[1] for column in conn.execute("PRAGMA table_info(cases)")}
            favorite = conn.execute("SELECT favorite FROM cases WHERE id='moke:worldbuilding-v17'").fetchone()[0]
        self.assertTrue({"video_url", "summary_zh"} <= columns)
        self.assertEqual(favorite, 1)

    def test_leader_video_detail_exposes_playback_and_source_translation(self):
        headings = ["uuid", "public", "title", "author", "tags", "model_tags", "catalog", "imgs", "prompt_origin"]
        index = [headings, ["vid123", True, "开箱视频", "作者", [], ["Veo3"], "视频", [["封面.webp", 800, 500]], "A product reveal."]]
        metadata = {"uuid": "vid123", "prompt_origin": "A product reveal.", "prompt_cn": "商品展示。", "vids": "预览视频.mp4"}

        def fetch(url, limit=9_000_000):
            if url.endswith("meta.json"):
                return json.dumps(metadata, ensure_ascii=False)
            return json.dumps(index, ensure_ascii=False)

        with patch.object(catalog, "_fetch", side_effect=fetch):
            self.assertEqual(self.client.post("/api/inspiration/sources/leaderai/sync").status_code, 200)
            detail = self.client.get("/api/inspiration/cases/leaderai:video:vid123").json()["case"]
        self.assertEqual(detail["prompt_zh"], "商品展示。")
        self.assertEqual(detail["video_url"], "https://cdn.leaderai.top/oss/moban-image/video_prompt/vids_src/v/vid123/%E9%A2%84%E8%A7%88%E8%A7%86%E9%A2%91.mp4")

    def test_repo_video_link_matches_its_own_case_section(self):
        item = {"source_id": "youmind_grok", "source_url": "https://github.com/YouMind-OpenLab/awesome-grok-imagine-prompts/blob/main/README.md?plain=1#L999", "title": "First"}
        readme = "# Gallery\n### First\n[Watch](https://youmind.com/grok-imagine-prompts?id=1377)\n### Second\n[Watch](https://youmind.com/grok-imagine-prompts?id=1428)"
        videos = {"prompts": {"1377": "https://github.com/YouMind-OpenLab/awesome-grok-imagine-prompts/releases/download/videos/1377.mp4"}}
        catalog._repo_video_catalog.cache_clear()
        with patch.object(catalog, "_fetch", side_effect=[readme, json.dumps(videos)]):
            self.assertEqual(catalog._repo_video_links(item), (videos["prompts"]["1377"], ""))
        catalog._repo_video_catalog.cache_clear()
        with patch.object(catalog, "_fetch", side_effect=[readme, json.dumps({"prompts": {}})]):
            self.assertEqual(catalog._repo_video_links(item), ("", "https://youmind.com/grok-imagine-prompts?id=1377"))
        catalog._repo_video_catalog.cache_clear()

    def test_repo_chinese_prompt_matches_preview_instead_of_changed_line_number(self):
        preview = "https://example.com/case.jpg"
        readme = ("# 案例\n### 另一个案例\n#### 提示词\n```\n别的内容。\n```\n"
                  "<img src=\"https://example.com/other.jpg\">\n"
                  "### 中文案例\n#### 📝 提示词\n```\n角色面向建筑师。\n```\n"
                  f"<img src=\"{preview}\">\n"
                  "[查看视频](https://youmind.com/grok-imagine-prompts?id=12348)\n")
        catalog._repo_chinese_cases.cache_clear()
        with patch.object(catalog, "_fetch", return_value=readme) as fetch:
            matched = catalog._repo_chinese_cases("youmind_grok")[preview]
            self.assertEqual(matched["title_zh"], "中文案例")
            self.assertEqual(matched["prompt_zh"], "角色面向建筑师。")
            self.assertEqual(matched["watch_url"], "https://youmind.com/grok-imagine-prompts?id=12348")
            self.assertEqual(catalog._repo_chinese_cases("youmind_grok")[preview], matched)
            self.assertEqual(fetch.call_count, 1)
        catalog._repo_chinese_cases.cache_clear()

    def test_youmind_detail_returns_free_source_translation(self):
        source = catalog.SOURCES["youmind_grok"]
        preview = "https://example.com/case.jpg"
        row = catalog._case_from_repo("youmind_grok", source, "example", "English Title", "An English prompt.", preview=preview)
        with patch.object(catalog, "_github_rows", return_value=[row]):
            self.assertEqual(self.client.post("/api/inspiration/sources/youmind_grok/sync").status_code, 200)
        chinese = {preview: {"title_zh": "中文标题", "prompt_zh": "中文提示词。", "video_url": "", "watch_url": "https://youmind.com/grok-imagine-prompts?id=12348"}}
        with patch.object(catalog, "_repo_chinese_cases", return_value=chinese), \
             patch.object(catalog, "_repo_video_links", return_value=("", chinese[preview]["watch_url"])):
            detail = self.client.get("/api/inspiration/cases/youmind_grok:example").json()["case"]
        self.assertEqual(detail["title_zh"], "中文标题")
        self.assertEqual(detail["prompt_zh"], "中文提示词。")
        self.assertEqual(detail["prompt"], "An English prompt.")

    def test_skill_filter_and_existing_moke_case_migration(self):
        skills = self.client.get("/api/inspiration/cases", params={"kind": "skill"}).json()
        self.assertEqual(skills["total"], 1)
        self.assertEqual(skills["cases"][0]["id"], "moke:worldbuilding-v17")
        self.assertEqual(self.client.get("/api/inspiration/cases", params={"kind": "workflow"}).json()["total"], 0)
        database = Path(self.temp.name) / "inspiration_library.sqlite3"
        with sqlite3.connect(database) as conn:
            conn.execute("UPDATE cases SET kind='workflow', favorite=1 WHERE id='moke:worldbuilding-v17'")
        catalog.install_inspiration_library(FastAPI(), types.SimpleNamespace(DATA_DIR=self.temp.name))
        migrated = self.client.get("/api/inspiration/cases", params={"kind": "skill"}).json()["cases"][0]
        self.assertTrue(migrated["favorite"])

    def test_moke_sync_reads_every_public_skill_page_and_preserves_previous_index_on_failure(self):
        base = "https://zcdn.rytesa.cn/moke-v3/example"
        def skill(identifier, slug):
            return {"id": str(identifier), "namespace": "maker--personal", "slug": slug,
                    "visibility": "PUBLIC", "display_name": slug, "summary_zh": f"{slug} 的简介",
                    "owner_display_name": "作者", "group_name": "视觉", "front_category": "image", "labels": []}
        pages = {1: [skill(101, "first"), skill(102, "second")], 2: [skill(103, "third")]}
        poster = {"maker--personal/first": {"title": "第一项 Skill", "image": "assets/skill-posters/first.webp"}}

        def fetch(url, limit=9_000_000):
            if url == catalog.SOURCES["moke"]["url"]:
                return f'<html data-moke-static-base="{base}">'
            if url == f"{base}/runtime/skill-posters.js":
                return "export default " + json.dumps(poster, ensure_ascii=False) + ";"
            if url.startswith("https://www.mokeaigc.com/api/skills?"):
                number = int(parse_qs(urlsplit(url).query)["page"][0])
                return json.dumps({"items": pages[number], "pagination": {"total": 3}}, ensure_ascii=False)
            raise AssertionError(url)

        with patch.object(catalog, "_fetch", side_effect=fetch):
            response = self.client.post("/api/inspiration/sources/moke/sync")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["item_count"], 3)
        result = self.client.get("/api/inspiration/cases", params={"kind": "skill"}).json()
        self.assertEqual(result["total"], 3)
        detail = self.client.get("/api/inspiration/cases/moke:101").json()["case"]
        self.assertEqual(detail["title"], "第一项 Skill")
        self.assertEqual(detail["workflow"], [{"step": "first 的简介"}])
        self.assertEqual(detail["preview_url"], f"{base}/assets/skill-posters/first.webp")
        self.assertEqual(detail["source_url"], "https://www.mokeaigc.com/skills/maker/maker--personal/first")
        self.assertEqual(detail["prompt"], "")
        self.assertEqual(self.client.patch("/api/inspiration/cases/moke:101/favorite", json={"favorite": True}).status_code, 200)

        def partial_fetch(url, limit=9_000_000):
            if "page=2" in url:
                raise RuntimeError("第二页暂时不可用")
            return fetch(url, limit)
        with patch.object(catalog, "_fetch", side_effect=partial_fetch):
            failed = self.client.post("/api/inspiration/sources/moke/sync")
        self.assertEqual(failed.status_code, 502)
        self.assertEqual(self.client.get("/api/inspiration/cases", params={"kind": "skill"}).json()["total"], 3)
        self.assertTrue(self.client.get("/api/inspiration/cases/moke:101").json()["case"]["favorite"])

    def test_moke_skill_installs_one_package_through_skill_manager(self):
        row = catalog._moke_seed_rows()[0] | {
            "id": "moke:91", "source_item_id": "91", "source_url":
            "https://www.mokeaigc.com/skills/honghouzi/honghouzi--video/professional-storyboard-director",
        }
        with patch.object(catalog, "_moke_rows", return_value=[row]):
            self.assertEqual(self.client.post("/api/inspiration/sources/moke/sync").status_code, 200)
        self.host.AGENT_SKILL_UPLOAD_DIR = str(Path(self.temp.name) / "imports")
        self.host._agent_skill_scan_package = lambda source: {
            "skills": [{"id": "professional-storyboard-director"}], "valid_count": 1,
        }
        self.host.AgentSkillPackageImportRequest = lambda **values: types.SimpleNamespace(**values)
        calls = []

        async def import_package(payload):
            calls.append((payload.skill_ids, payload.replace, Path(payload.source_dir, "SKILL.md").read_text()))
            return {"imported": [{"id": payload.skill_ids[0]}], "skipped": [], "conflicts": [], "errors": []}

        self.host.import_agent_skill_package = import_package

        def download(case, source_dir):
            self.assertEqual(case["source_item_id"], "91")
            Path(source_dir, "SKILL.md").write_text("---\nname: professional-storyboard-director\n---\nUse this skill.")

        with patch.object(catalog, "_download_moke_skill", side_effect=download):
            response = self.client.post("/api/inspiration/cases/moke:91/install-skill", json={"replace": False})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["skill_id"], "professional-storyboard-director")
        self.assertEqual(calls, [(["professional-storyboard-director"], False,
                                  "---\nname: professional-storyboard-director\n---\nUse this skill.")])
        self.assertEqual(list(Path(self.host.AGENT_SKILL_UPLOAD_DIR).iterdir()), [])
        database = Path(self.temp.name) / "inspiration_library.sqlite3"
        with sqlite3.connect(database) as conn:
            conn.execute("UPDATE cases SET kind='image' WHERE id='moke:91'")
        self.assertEqual(self.client.post("/api/inspiration/cases/moke:91/install-skill", json={}).status_code, 400)

    def test_moke_download_rejects_unsafe_zip_and_blocked_skill(self):
        case = {"source_id": "moke", "kind": "skill", "source_item_id": "91",
                "source_url": "https://www.mokeaigc.com/skills/honghouzi/honghouzi--video/professional-storyboard-director"}
        metadata = {"item": {"id": "91", "namespace": "honghouzi--video",
                             "slug": "professional-storyboard-director", "visibility": "PUBLIC", "security_verdict": "SAFE"}}
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zip_file:
            zip_file.writestr("../outside.txt", "unsafe")

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def raise_for_status(self): return None
            def iter_content(self, size): yield archive.getvalue()

        with tempfile.TemporaryDirectory() as source_dir:
            with patch.object(catalog, "_fetch", return_value=json.dumps(metadata)), patch.object(catalog.requests, "get", return_value=Response()):
                with self.assertRaisesRegex(Exception, "无效路径"):
                    catalog._download_moke_skill(case, source_dir)
            self.assertFalse(Path(source_dir, "outside.txt").exists())
            metadata["item"]["security_verdict"] = "BLOCKED"
            with patch.object(catalog, "_fetch", return_value=json.dumps(metadata)), patch.object(catalog.requests, "get") as request:
                with self.assertRaisesRegex(Exception, "严重安全问题"):
                    catalog._download_moke_skill(case, source_dir)
                request.assert_not_called()

    def test_leaderai_detail_loads_full_prompt_and_model_filters_follow_kind(self):
        headings = ["uuid", "public", "title", "author", "tags", "model_tags", "catalog", "imgs", "prompt_origin"]
        full_prompt = "A detailed image prompt with many visual notes and complete lighting and composition instructions."
        preview = full_prompt[:45] + "..."
        image = [headings, ["image123", True, "图片案例", "作者", [], ["Nano Banana Pro"], "主图", [], preview]]
        video = [headings, ["video123", True, "视频案例", "作者", [], ["Seedance 2.0"], "视频", [], "A video prompt preview with camera motion..."]]

        def fetch(url, limit=9_000_000):
            if url.endswith("meta.json"):
                self.assertIn("image123", url)
                return json.dumps({"uuid": "image123", "prompt_origin": full_prompt})
            return json.dumps(image if "image_prompt" in url else video)

        with patch.object(catalog, "_fetch", side_effect=fetch):
            response = self.client.post("/api/inspiration/sources/leaderai/sync")
            self.assertEqual(response.status_code, 200, response.text)
            case_id = "leaderai:image:image123"
            detail = self.client.get(f"/api/inspiration/cases/{case_id}").json()["case"]
            self.assertEqual(detail["prompt"], full_prompt)
            self.assertNotIn("prompt_incomplete", detail)

        images = self.client.get("/api/inspiration/cases", params={"kind": "image"}).json()
        videos = self.client.get("/api/inspiration/cases", params={"kind": "video"}).json()
        self.assertEqual([model["name"] for model in images["models"]], ["Nano Banana"])
        self.assertEqual([model["name"] for model in videos["models"]], ["Seedance"])

        with patch.object(catalog, "_fetch", side_effect=RuntimeError("来源离线")):
            self.assertEqual(self.client.get(f"/api/inspiration/cases/{case_id}").json()["case"]["prompt"], full_prompt)
            unavailable = self.client.get("/api/inspiration/cases/leaderai:video:video123").json()["case"]
            self.assertTrue(unavailable["prompt_incomplete"])
            self.assertTrue(unavailable["prompt"].endswith("..."))

        with patch.object(catalog, "_fetch", side_effect=fetch):
            self.assertEqual(self.client.post("/api/inspiration/sources/leaderai/sync").status_code, 200)
        self.assertEqual(self.client.get(f"/api/inspiration/cases/{case_id}").json()["case"]["prompt"], full_prompt)

    def test_markdown_source_keeps_one_case_when_prompt_contains_heading(self):
        readme = """## Image Cases
### 1. Sample Case
**Prompt:**
```text
Draw a product on a clean table.
### This line is part of the prompt
Keep the label readable.
```
<img src="images/sample.png" alt="sample">
### About this repository
This section is not a case.
"""
        with patch.object(catalog, "_fetch", return_value=readme):
            response = self.client.post("/api/inspiration/sources/zerolu_banana/sync")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["item_count"], 1)
        item = self.client.get("/api/inspiration/cases", params={"source": "zerolu_banana"}).json()["cases"][0]
        self.assertEqual(item["title"], "Sample Case")
        detail = self.client.get(f"/api/inspiration/cases/{item['id']}").json()["case"]
        self.assertIn("### This line is part of the prompt", detail["prompt"])
        self.assertIn("README.md?plain=1#L2", detail["source_url"])


if __name__ == "__main__":
    unittest.main()
