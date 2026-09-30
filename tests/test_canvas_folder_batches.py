"""Folder batch integration tests; all media and state live in temporary folders."""

import asyncio
import copy
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, unquote, urlsplit
from unittest.mock import patch
import zipfile

import httpx
from fastapi import FastAPI, HTTPException
from PIL import Image

from canvas_folder_batches import (
    FolderBatchService,
    FolderImport,
    FolderPlan,
    GenerationSettings,
    PlanEdits,
    PlanItemEdit,
    RetryRequest,
    install_folder_batches,
)


class FakeHost:
    """Record the host protocol and keep upstream task state across service restarts."""

    def __init__(self, root):
        self.root = root.resolve()
        self.DATA_DIR = str(self.root / "data")
        self.assets = self.root / "assets"
        self.output = self.root / "生成素材"
        for path in (Path(self.DATA_DIR), self.assets, self.output):
            path.mkdir(parents=True)
        self.CanvasLLMRequest = SimpleNamespace
        self.OnlineImageRequest = SimpleNamespace
        self.AIReference = SimpleNamespace
        self.providers = {
            "vision-provider": {"chat_models": ["vision-model"], "image_models": []},
            "image-provider": {"chat_models": [], "image_models": ["image-model"]},
        }
        self.imports = []
        self.registry = {}
        self.llm_calls = []
        self.create_calls = []
        self.query_calls = []
        self.recover_calls = []
        self.tasks = {}
        self.by_client = {}
        self.llm_transform = None
        self.llm_gate = None
        self.create_gate = None
        self.task_gate = None
        self.llm_started = asyncio.Event()
        self.created = asyncio.Event()
        self.queried = asyncio.Event()
        self.task_result = None

    def confined(self, path):
        path = Path(path).resolve()
        if not path.is_relative_to(self.root):
            raise AssertionError(f"Fixture access escaped its temporary root: {path}")
        return path

    def import_local_image_file(self, filename):
        source = self.confined(filename)
        destination = self.assets / f"import-{len(self.imports):04d}{source.suffix}"
        shutil.copyfile(source, destination)
        self.imports.append((source, destination))
        return {"url": "/assets/" + quote(destination.name)}

    def asset_registry_register_media(self, url, **metadata):
        self.confined(self.local_media_path_from_url(url))
        if url not in self.registry:
            self.registry[url] = {"id": f"asset_{len(self.registry):016x}", "url": url}
        self.registry[url].update(copy.deepcopy(metadata))
        return copy.deepcopy(self.registry[url])

    def get_api_provider_exact(self, provider_id):
        if provider_id not in self.providers:
            raise HTTPException(400, "测试平台不存在或已禁用")
        return copy.deepcopy(self.providers[provider_id])

    def output_path_for(self, filename, category="output"):
        return str(self.confined(self.output / filename))

    def output_url_for(self, filename, category="output"):
        return "/output/" + quote(filename, safe="/")

    def local_media_path_from_url(self, url):
        clean = unquote(urlsplit(url).path)
        for prefix, root in (("/assets/", self.assets), ("/output/", self.output)):
            if clean.startswith(prefix):
                return str(self.confined(root / clean[len(prefix):]))
        return None

    async def canvas_llm(self, request):
        self.llm_calls.append(request)
        self.llm_started.set()
        if self.llm_gate is not None:
            await self.llm_gate.wait()
        manifest = json.loads(request.message)["images_in_order"]
        if len(manifest) != len(request.images):
            raise AssertionError("Manifest and actual vision inputs must align")
        for url, item in zip(request.images, manifest):
            with Image.open(self.local_media_path_from_url(url)) as picture:
                if list(picture.size) != [item["width"], item["height"]]:
                    raise AssertionError("Vision input does not match its manifest")
        plans = [
            {"id": item["id"], "description": f"观察：{item['name']}",
             "prompt": f"保留商品细节，修改 {item['id']} 的背景", "selected": True}
            for item in manifest
        ]
        response = {"text": json.dumps({"items": plans}, ensure_ascii=False),
                    "vision_input": {"requested": len(manifest), "submitted": len(manifest), "skipped": 0}}
        if self.llm_transform is not None:
            response = self.llm_transform(len(self.llm_calls), plans, response)
        return response

    async def create_canvas_image_task(self, request):
        # Count calls even for repeated client IDs, so host deduplication cannot hide a bug.
        self.create_calls.append(copy.deepcopy(request))
        if request.client_request_id in self.by_client:
            return {"task_id": self.by_client[request.client_request_id]}
        task_id = f"canvas_img_{len(self.tasks):032x}"
        self.by_client[request.client_request_id] = task_id
        result = self.task_result(request) if self.task_result else "succeeded"
        if result == "succeeded":
            filename = f"upstream-{len(self.tasks)}.png"
            Image.new("RGB", (40, 30), (40, 80, 120)).save(self.output / filename)
            task = {"status": "succeeded", "result": {"images": [self.output_url_for(filename)]}}
        elif isinstance(result, dict):
            task = copy.deepcopy(result)
        else:
            task = {"status": result, "error": "测试上游失败" if result == "failed" else ""}
        self.tasks[task_id] = task
        self.created.set()
        if self.create_gate is not None:
            await self.create_gate.wait()
        return {"task_id": task_id, "status": "queued"}

    async def get_canvas_image_task(self, task_id):
        self.query_calls.append(task_id)
        self.queried.set()
        if self.task_gate is not None:
            await self.task_gate.wait()
        if task_id not in self.tasks:
            raise HTTPException(404, "测试任务不存在")
        return copy.deepcopy(self.tasks[task_id])

    async def recover_canvas_image_task(self, client_request_id):
        self.recover_calls.append(client_request_id)
        if client_request_id not in self.by_client:
            raise HTTPException(404, "测试关联任务不存在")
        return {"task_id": self.by_client[client_request_id], "recovered": True}


class FolderBatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="canvas-folder-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "中文工作区"
        self.root.mkdir()
        self.source = self.root / "原图 商品"
        self.source.mkdir()
        self.host = FakeHost(self.root)
        self.service = self.new_service()

    def new_service(self):
        service = FolderBatchService(self.host)
        service.poll_interval = .001
        self.addAsyncCleanup(service.shutdown)
        return service

    def image(self, relative, color=(100, 40, 80), size=(32, 24)):
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", size, color).save(path)
        return path

    def snapshot_source(self):
        return {p.relative_to(self.source).as_posix():
                (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns)
                for p in self.source.rglob("*") if p.is_file()}

    def import_images(self, count=3):
        for index in range(count):
            self.image(f"商品_{index:03d}.png", color=(index % 256, 40, 80))
        imported = self.service.import_folder(FolderImport(
            path=str(self.source), canvas_id="画布-测试", conversation_id="会话-测试"))
        return self.service.get(imported["id"])

    def plan_payload(self, **overrides):
        values = dict(message="所有商品改成透明底，保留细节", provider="vision-provider",
                      model="vision-model", skill_id="test-skill", generation=GenerationSettings(
                          provider_id="image-provider", model="image-model", size="1536x1024",
                          aspect_ratio="3:2", quality="high", background="transparent"))
        values.update(overrides)
        return FolderPlan(**values)

    async def wait_worker(self, batch, service=None):
        service = service or self.service
        task = service.workers.get(batch["id"])
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), timeout=3)
        return service.get(batch["id"])

    async def wait_until(self, predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(.001)
        await asyncio.wait_for(poll(), timeout=3)

    async def ready(self, count=3):
        batch = self.import_images(count)
        await self.service.plan(batch["id"], self.plan_payload())
        await self.wait_worker(batch)
        self.assertEqual(batch["status"], "ready", batch.get("error"))
        self.assertFalse(self.host.create_calls)
        return batch

    async def complete(self, count=3):
        batch = await self.ready(count)
        await self.service.execute(batch["id"], batch["revision"])
        await self.wait_worker(batch)
        self.assertEqual(batch["status"], "completed", batch.get("error"))
        return batch

    async def test_import_chinese_nested_same_names_duplicates_corrupt_and_source_unchanged(self):
        first = self.image("商品.png")
        self.image("子目录/商品.png", color=(10, 20, 30), size=(17, 19))
        duplicate = self.source / "子目录/副本.PNG"
        shutil.copyfile(first, duplicate)
        (self.source / "损坏.jpg").write_bytes(b"not an image")
        (self.source / "说明.txt").write_text("不是图片", encoding="utf-8")
        self.image(".隐藏目录/忽略.png")
        before = self.snapshot_source()
        batch = self.service.import_folder(FolderImport(path=str(self.source)))
        items = {item["relative_path"]: item for item in batch["items"]}
        self.assertEqual(set(items), {"商品.png", "子目录/商品.png", "子目录/副本.PNG", "损坏.jpg"})
        self.assertEqual(items["子目录/商品.png"]["width"], 17)
        self.assertEqual(items["子目录/商品.png"]["height"], 19)
        self.assertEqual(items["损坏.jpg"]["status"], "unreadable")
        self.assertTrue(items["损坏.jpg"]["error"])
        self.assertFalse(items["损坏.jpg"]["url"])
        self.assertEqual(items["子目录/副本.PNG"]["duplicate_of"], items["商品.png"]["id"])
        self.assertNotEqual(items["商品.png"]["url"], items["子目录/商品.png"]["url"])
        self.assertEqual(len(self.host.imports), 3)
        self.assertEqual(before, self.snapshot_source())
        self.assertEqual(len(self.new_service().get(batch["id"])["items"]), 4)

    async def test_import_empty_or_missing_folder_has_no_side_effects(self):
        for source in (self.source, self.source / "不存在"):
            with self.subTest(source=source), self.assertRaises(HTTPException) as caught:
                self.service.import_folder(FolderImport(path=str(source)))
            self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse(self.host.imports)
        self.assertFalse(self.service.root.exists())

    async def test_import_limit_rejects_before_copying_any_file(self):
        for index in range(201):
            self.image(f"{index:03d}.png")
        with self.assertRaises(HTTPException) as caught:
            self.service.import_folder(FolderImport(path=str(self.source)))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse(self.host.imports)
        self.assertFalse(self.service.root.exists())

    async def test_plan_batches_eight_cover_every_image_once(self):
        batch = await self.ready(19)
        self.assertEqual([len(r.images) for r in self.host.llm_calls], [8, 8, 3])
        sent = [url for request in self.host.llm_calls for url in request.images]
        self.assertEqual(Counter(sent), Counter(item["url"] for item in batch["items"]))
        sent_ids = [entry["id"] for request in self.host.llm_calls
                    for entry in json.loads(request.message)["images_in_order"]]
        self.assertEqual(Counter(sent_ids), Counter(item["id"] for item in batch["items"]))
        self.assertEqual(batch["analysis_done"], 19)
        self.assertEqual(batch["analysis_total"], 19)
        for request in self.host.llm_calls:
            self.assertEqual((request.provider, request.model, request.skill_id),
                             ("vision-provider", "vision-model", "test-skill"))
        self.assertTrue(all(x["description"] and x["prompt"] and x["selected"] for x in batch["items"]))

    async def test_plan_missing_id_blocks_entire_execution_even_after_other_chunk_succeeds(self):
        def incomplete(call, plans, response):
            if call == 2:
                response["text"] = json.dumps({"items": plans[:-1]})
            return response
        self.host.llm_transform = incomplete
        batch = self.import_images(10)
        await self.service.plan(batch["id"], self.plan_payload())
        await self.wait_worker(batch)
        self.assertEqual(batch["status"], "plan_failed")
        self.assertTrue(all(x["prompt"] for x in batch["items"][:8]))
        self.assertTrue(all(x["error"] and not x["selected"] for x in batch["items"][8:]))
        with self.assertRaises(HTTPException) as caught:
            await self.service.execute(batch["id"], batch["revision"])
        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(self.host.create_calls)

    async def test_llm_exception_and_unreadable_vision_cannot_execute(self):
        def unavailable(call, plans, response):
            raise HTTPException(503, "模型暂不可用")
        def unreadable(call, plans, response):
            response["vision_input"]["skipped"] = 1
            response["vision_input"]["submitted"] -= 1
            return response
        for transform in (unavailable, unreadable):
            with self.subTest(transform=transform.__name__):
                self.host.llm_transform = transform
                batch = self.import_images(2)
                await self.service.plan(batch["id"], self.plan_payload())
                await self.wait_worker(batch)
                self.assertEqual(batch["status"], "plan_failed")
                with self.assertRaises(HTTPException):
                    await self.service.execute(batch["id"], batch["revision"])
                self.assertFalse(self.host.create_calls)

    async def test_source_ratio_is_resolved_for_each_individual_image(self):
        self.image('横图.png', size=(400, 200))
        self.image('竖图.png', size=(200, 400))
        batch = self.service.import_folder(FolderImport(path=str(self.source)))
        self.service.batches[batch['id']] = batch
        payload = self.plan_payload()
        payload.generation.size = '1024x1024'
        payload.generation.aspect_ratio = 'source'
        await self.service.plan(batch['id'], payload)
        await self.wait_worker(batch)
        await self.service.execute(batch['id'], batch['revision'])
        await self.wait_worker(batch)
        self.assertEqual({request.size for request in self.host.create_calls}, {'1024x512', '512x1024'})
        self.assertTrue(all(request.aspect_ratio == 'source' for request in self.host.create_calls))

    async def test_dynamic_missing_model_rejected_before_planning_and_before_execution(self):
        batch = self.import_images(1)
        with self.assertRaises(HTTPException) as caught:
            await self.service.plan(batch["id"], self.plan_payload(model="removed-model"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse(self.host.llm_calls)
        await self.service.plan(batch["id"], self.plan_payload())
        await self.wait_worker(batch)
        self.host.providers["image-provider"]["image_models"] = []
        with self.assertRaises(HTTPException) as caught:
            await self.service.execute(batch["id"], batch["revision"])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse(self.host.create_calls)

    async def test_revision_race_edit_wins_and_old_confirmation_cannot_execute(self):
        batch = await self.ready(1)
        original = batch["revision"]
        edit = PlanEdits(revision=original, items=[PlanItemEdit(
            id=batch["items"][0]["id"], selected=True, prompt="修订后的指令")])
        result = await asyncio.gather(self.service.edit_plan(batch["id"], edit),
                                      self.service.execute(batch["id"], original), return_exceptions=True)
        self.assertIsInstance(result[0], dict)
        self.assertIsInstance(result[1], HTTPException)
        self.assertEqual(result[1].status_code, 409)
        self.assertFalse(self.host.create_calls)
        await self.service.execute(batch["id"], batch["revision"])
        await self.wait_worker(batch)
        self.assertEqual(self.host.create_calls[0].prompt, "修订后的指令")

    async def test_revision_race_execute_wins_and_late_edit_cannot_change_submitted_prompt(self):
        batch = await self.ready(1)
        original_prompt = batch["items"][0]["prompt"]
        revision = batch["revision"]
        edit = PlanEdits(revision=revision, items=[PlanItemEdit(
            id=batch["items"][0]["id"], selected=True, prompt="迟到的改动")])
        result = await asyncio.gather(self.service.execute(batch["id"], revision),
                                      self.service.edit_plan(batch["id"], edit), return_exceptions=True)
        self.assertIsInstance(result[0], dict)
        self.assertIsInstance(result[1], HTTPException)
        self.assertEqual(result[1].status_code, 409)
        await self.wait_worker(batch)
        self.assertEqual(self.host.create_calls[0].prompt, original_prompt)

    async def test_duplicate_execute_never_submits_duplicate_tasks(self):
        batch = await self.ready(5)
        revision = batch["revision"]
        replies = await asyncio.gather(*(self.service.execute(batch["id"], revision) for _ in range(2)))
        self.assertEqual(replies[0]["revision"], replies[1]["revision"])
        await self.wait_worker(batch)
        await self.service.execute(batch["id"], revision)
        self.assertEqual(len(self.host.create_calls), 5)
        self.assertEqual(len({r.client_request_id for r in self.host.create_calls}), 5)
        self.assertTrue(all(x["attempt"] == 1 for x in batch["items"]))

    async def test_single_image_parameters_and_reference_are_mapped_without_overwriting_source(self):
        batch = await self.ready(3)
        before = self.snapshot_source()
        chosen = batch["items"][1]
        edits = [PlanItemEdit(id=x["id"], selected=x is chosen, prompt=x["prompt"]) for x in batch["items"]]
        await self.service.edit_plan(batch["id"], PlanEdits(revision=batch["revision"], items=edits))
        await self.service.execute(batch["id"], batch["revision"])
        await self.wait_worker(batch)
        self.assertEqual(len(self.host.create_calls), 1)
        request = self.host.create_calls[0]
        for key, value in batch["generation"].items():
            self.assertEqual(getattr(request, key), value, key)
        self.assertEqual((request.n, request.prompt, request.history_source, request.skill_id),
                         (1, chosen["prompt"], "canvas", "test-skill"))
        self.assertEqual(len(request.reference_images), 1)
        self.assertEqual(vars(request.reference_images[0]),
                         {"url": chosen["url"], "name": chosen["name"], "kind": "image"})
        self.assertEqual([x["status"] for x in batch["items"]], ["skipped", "succeeded", "skipped"])
        result = Path(self.host.local_media_path_from_url(chosen["result_url"]))
        with Image.open(result) as picture:
            picture.verify()
        self.assertFalse(result.is_relative_to(self.source))
        self.assertEqual(before, self.snapshot_source())
        self.assertEqual(self.host.registry[chosen["result_url"]]["derived_from"], [chosen["asset_ref_id"]])

    async def test_mixed_results_and_retry_only_specified_item(self):
        batch = await self.ready(4)
        target = batch["items"][1]
        self.host.task_result = lambda request: "failed" if target["id"] in request.client_request_id else "succeeded"
        await self.service.execute(batch["id"], batch["revision"])
        await self.wait_worker(batch)
        self.assertEqual(Counter(x["status"] for x in batch["items"]), {"succeeded": 3, "failed": 1})
        self.assertTrue(target["error"])
        others = copy.deepcopy([x for x in batch["items"] if x is not target])
        original_request = self.host.create_calls[1].client_request_id
        self.host.task_result = None
        await self.service.retry(batch["id"], target["id"], RetryRequest(
            revision=batch["revision"], feedback="保留标签上的中文"))
        await self.wait_worker(batch)
        self.assertEqual(len(self.host.create_calls), 5)
        self.assertIn(target["id"], self.host.create_calls[-1].client_request_id)
        self.assertNotEqual(original_request, self.host.create_calls[-1].client_request_id)
        self.assertIn("保留标签上的中文", self.host.create_calls[-1].prompt)
        self.assertEqual(target["attempt"], 2)
        self.assertEqual(target["status"], "succeeded")
        self.assertEqual(others, [x for x in batch["items"] if x is not target])

    async def test_pause_resume_only_submits_previously_unsubmitted_items(self):
        batch = await self.ready(5)
        self.host.task_gate = asyncio.Event()
        await self.service.execute(batch["id"], batch["revision"])
        await self.wait_until(lambda: len(self.host.create_calls) == 2)
        await self.service.pause(batch["id"])
        self.host.task_gate.set()
        await self.wait_worker(batch)
        self.assertEqual(len(self.host.create_calls), 2)
        self.assertEqual(batch["status"], "paused")
        self.assertEqual(Counter(x["status"] for x in batch["items"]), {"succeeded": 2, "queued": 3})
        await self.service.resume(batch["id"])
        await self.wait_worker(batch)
        self.assertEqual(len(self.host.create_calls), 5)
        self.assertTrue(all(x["attempt"] == 1 and x["status"] == "succeeded" for x in batch["items"]))

    async def test_retry_in_paused_batch_holds_unrelated_queued_items(self):
        batch = await self.ready(5)
        self.host.task_gate = asyncio.Event()
        await self.service.execute(batch["id"], batch["revision"])
        await self.wait_until(lambda: len(self.host.create_calls) == 2)
        await self.service.pause(batch["id"])
        self.host.task_gate.set()
        await self.wait_worker(batch)
        target = batch["items"][0]
        others = copy.deepcopy(batch["items"][1:])
        await self.service.retry(batch["id"], target["id"], RetryRequest(
            revision=batch["revision"], feedback="提高亮度"))
        await self.wait_worker(batch)
        self.assertEqual(len(self.host.create_calls), 3)
        self.assertEqual(batch["status"], "paused")
        self.assertEqual(batch["items"][1:], others)
        self.assertEqual(target["attempt"], 2)
        self.assertEqual(len(target["versions"]), 2)

    async def test_restart_queries_known_task_and_does_not_regenerate(self):
        batch = await self.ready(1)
        self.host.task_gate = asyncio.Event()
        await self.service.execute(batch["id"], batch["revision"])
        await asyncio.wait_for(self.host.queried.wait(), timeout=3)
        task_id = batch["items"][0]["task_id"]
        await self.service.shutdown()
        restarted = self.new_service()
        restored = restarted.get(batch["id"])
        self.assertEqual(restored["status"], "interrupted")
        self.assertEqual(restored["items"][0]["task_id"], task_id)
        self.host.task_gate.set()
        await restarted.resume(batch["id"])
        await self.wait_worker(restored, restarted)
        self.assertEqual(restored["items"][0]["status"], "succeeded")
        self.assertEqual(len(self.host.create_calls), 1)
        self.assertFalse(self.host.recover_calls)
        self.assertGreaterEqual(self.host.query_calls.count(task_id), 2)

    async def test_restart_recovers_client_id_when_crash_happens_after_submit_before_ack(self):
        batch = await self.ready(1)
        self.host.create_gate = asyncio.Event()
        await self.service.execute(batch["id"], batch["revision"])
        await asyncio.wait_for(self.host.created.wait(), timeout=3)
        self.assertFalse(batch["items"][0]["task_id"])
        client_id = self.host.create_calls[0].client_request_id
        await self.service.shutdown()
        restarted = self.new_service()
        restored = restarted.get(batch["id"])
        self.host.create_gate.set()
        await restarted.resume(batch["id"])
        await self.wait_worker(restored, restarted)
        self.assertEqual(self.host.recover_calls, [client_id])
        self.assertEqual(len(self.host.create_calls), 1)
        self.assertEqual(restored["items"][0]["status"], "succeeded")
        self.assertEqual(restored["items"][0]["attempt"], 1)

    async def test_pending_upstream_resume_only_queries_existing_task(self):
        self.host.task_result = lambda request: "jimeng_pending"
        batch = await self.ready(1)
        await self.service.execute(batch["id"], batch["revision"])
        await self.wait_worker(batch)
        self.assertEqual(batch["status"], "paused")
        item = batch["items"][0]
        self.assertEqual(item["status"], "waiting_upstream")
        filename = "已完成.png"
        Image.new("RGB", (30, 20)).save(self.host.output / filename)
        self.host.tasks[item["task_id"]] = {"status": "succeeded", "result": {
            "image_items": [{"url": self.host.output_url_for(filename)}]}}
        await self.service.resume(batch["id"])
        await self.wait_worker(batch)
        self.assertEqual(item["status"], "succeeded")
        self.assertEqual(len(self.host.create_calls), 1)

    async def test_retry_collects_already_succeeded_task_without_regenerating(self):
        self.host.task_result = lambda request: {"status": "succeeded", "result": {
            "images": [self.host.output_url_for("延迟落盘.png")]}}
        batch = await self.complete(1)
        item = batch["items"][0]
        self.assertEqual(item["status"], "failed")
        Image.new("RGB", (30, 20)).save(self.host.output / "延迟落盘.png")
        await self.service.retry(batch["id"], item["id"], RetryRequest(revision=batch["revision"]))
        self.assertEqual(item["status"], "succeeded")
        self.assertEqual(item["attempt"], 1)
        self.assertEqual(len(self.host.create_calls), 1)

    async def test_previous_result_versions_remain_registered_as_batch_references(self):
        batch = await self.complete(1)
        item = batch["items"][0]
        previous_url = item["result_url"]
        previous_asset = item["result_asset_ref_id"]
        self.assertTrue(self.service.references(previous_asset))
        await self.service.retry(batch["id"], item["id"], RetryRequest(
            revision=batch["revision"], feedback="略微提高亮度"))
        await self.wait_worker(batch)
        self.assertNotEqual(item["result_url"], previous_url)
        self.assertTrue(any(version["url"] == previous_url for version in item["versions"]))
        self.assertTrue(self.service.references(previous_asset),
                        "A retained historical result must not become unreferenced after retry")

    async def test_analysis_pause_and_restart_requires_new_plan_and_confirmation(self):
        batch = self.import_images(3)
        self.host.llm_gate = asyncio.Event()
        await self.service.plan(batch["id"], self.plan_payload())
        await asyncio.wait_for(self.host.llm_started.wait(), timeout=3)
        await self.service.pause(batch["id"])
        await self.service.shutdown()
        restarted = self.new_service()
        restored = restarted.get(batch["id"])
        with self.assertRaises(HTTPException):
            await restarted.resume(batch["id"])
        with self.assertRaises(HTTPException):
            await restarted.execute(batch["id"], restored["revision"])
        self.assertFalse(self.host.create_calls)
        self.host.llm_gate.set()
        await restarted.plan(batch["id"], self.plan_payload())
        await self.wait_worker(restored, restarted)
        self.assertEqual(restored["status"], "ready")

    async def test_routes_import_plan_edit_execute_report_and_download(self):
        self.image("商品.png")
        self.image("子目录/商品.png", color=(20, 80, 120))
        app = FastAPI()
        service = install_folder_batches(app, self.host)
        service.poll_interval = .001
        self.addAsyncCleanup(service.shutdown)
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 32100))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:3000") as client:
            prefix = "/api/canvas-folder-batches"
            response = await client.post(prefix, json={"path": str(self.source), "canvas_id": "canvas", "conversation_id": "chat"})
            self.assertEqual(response.status_code, 200, response.text)
            batch = response.json()
            base = prefix + "/" + batch["id"]
            listing = await client.get(prefix, params={"canvas_id": "canvas", "conversation_id": "chat"})
            self.assertEqual([x["id"] for x in listing.json()["batches"]], [batch["id"]])
            self.assertEqual((await client.get(prefix)).json()["batches"], [])
            self.assertEqual((await client.get(base + "/download")).status_code, 400)
            self.assertEqual((await client.get(base + f"/items/{batch['items'][0]['id']}/download")).status_code, 404)
            planned = await client.post(base + "/plan", json=self.plan_payload().model_dump())
            self.assertEqual(planned.status_code, 200, planned.text)
            current = await self.wait_worker(batch, service)
            edited = await client.patch(base + "/plan", json={"revision": current["revision"], "items": []})
            self.assertEqual(edited.status_code, 200, edited.text)
            response = await client.post(base + "/execute", json={"revision": edited.json()["revision"]})
            self.assertEqual(response.status_code, 200, response.text)
            await self.wait_worker(batch, service)
            report = (await client.get(base + "/report.json")).json()
            self.assertEqual(report["status"], "completed")
            self.assertFalse(any(key.startswith("_") for key in report))
            for item in report["items"]:
                single = await client.get(base + f"/items/{item['id']}/download")
                self.assertEqual(single.status_code, 200, single.text if single.status_code != 200 else "")
                self.assertIn("attachment", single.headers["content-disposition"])
                with Image.open(io.BytesIO(single.content)) as picture:
                    picture.verify()
            captured = []
            original_mkstemp = tempfile.mkstemp
            def record_temp(*args, **kwargs):
                # Keep route-created ZIPs inside this fixture as well.
                kwargs.setdefault("dir", self.root)
                fd, filename = original_mkstemp(*args, **kwargs)
                if str(filename).endswith(".zip"):
                    captured.append(Path(filename))
                return fd, filename
            with patch("canvas_folder_batches.tempfile.mkstemp", side_effect=record_temp):
                packed = await client.get(base + "/download")
            self.assertEqual(packed.status_code, 200)
            with zipfile.ZipFile(io.BytesIO(packed.content)) as archive:
                names = archive.namelist()
                self.assertEqual(len(names), 3)
                self.assertEqual(len(set(names)), 3)
                self.assertIn("小美处理报告.json", names)
                self.assertEqual(json.loads(archive.read("小美处理报告.json"))["id"], batch["id"])
            self.assertTrue(captured)
            self.assertTrue(all(not path.exists() for path in captured))

    async def test_routes_reject_nonlocal_cross_origin_and_unknown_ids(self):
        app = FastAPI()
        service = install_folder_batches(app, self.host)
        self.addAsyncCleanup(service.shutdown)
        prefix = "/api/canvas-folder-batches"
        for address, headers in (("192.0.2.1", {}), ("127.0.0.1", {"Origin": "https://external.example"}),
                                 ("127.0.0.1", {"Sec-Fetch-Site": "cross-site"})):
            with self.subTest(address=address, headers=headers):
                transport = httpx.ASGITransport(app=app, client=(address, 32100))
                async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:3000") as client:
                    reply = await client.post(prefix, json={"path": str(self.source)}, headers=headers)
                    self.assertEqual(reply.status_code, 403)
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 32100))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:3000") as client:
            self.assertEqual((await client.get(prefix + "/folder_" + "0" * 32)).status_code, 404)
            self.assertEqual((await client.post(prefix, json={})).status_code, 422)
        self.assertFalse(self.host.imports)


if __name__ == "__main__":
    unittest.main()
