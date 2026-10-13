"""Exercise the OCR API without reading user configuration or calling paid models."""
import ast
import asyncio
import base64
from io import BytesIO
import json
import math
from pathlib import Path
import re
import unittest

import httpx
from fastapi import FastAPI, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel, Field


class APIOCRTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        source = Path(__file__).resolve().parents[1] / "main.py"
        names = {"ImageOCRRequest", "_group_ocr_text_items", "_api_ocr_result_items", "image_ocr"}
        tree = ast.parse(source.read_text(encoding="utf-8"))
        body = [node for node in tree.body if getattr(node, "name", "") in names]
        self.assertEqual(len(body), len(names))
        self.calls = []
        self.result = {"text": json.dumps({"items": [
            {"text":"5包", "x":.7,"y":.4,"width":.1,"height":.06},
            {"text":"服务", "x":.7,"y":.48,"width":.1,"height":.06}
        ]}), "model":"fixture-vision", "vision_input":{"submitted":1}}
        self.error = None
        self.provider = {"id":"fixture","protocol":"openai","chat_models":["fixture-vision"]}
        def resolve(provider_id):
            if provider_id != "fixture":
                raise HTTPException(status_code=400,detail="未找到 API 平台")
            return self.provider
        async def canvas_llm(payload):
            self.calls.append(payload)
            if self.error:
                raise self.error
            return self.result
        class CanvasLLMRequest:
            def __init__(self, **kwargs):
                self.__dict__.update({"skill_id": "", "link_job_ids": [], "messages": [], "system_prompt": "", **kwargs})
        self.app = FastAPI()
        self.ns = dict(globals(), app=self.app, AI_REFERENCE_UPLOAD_MAX_BYTES=50*1024*1024,
                       get_api_provider_exact=resolve, canvas_llm=canvas_llm, CanvasLLMRequest=CanvasLLMRequest,
                       is_codex_provider=lambda p:p.get("protocol")=="codex",
                       is_gemini_cli_provider=lambda p:p.get("protocol")=="gemini-cli")
        exec(compile(ast.Module(body=body,type_ignores=[]),str(source),"exec"),self.ns)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url="http://localhost")
        self.addAsyncCleanup(self.client.aclose)
        buffer = BytesIO()
        Image.new("RGB",(1000,500),"white").save(buffer,format="PNG")
        self.data = "data:image/png;base64,"+base64.b64encode(buffer.getvalue()).decode("ascii")

    async def request(self, **values):
        return await self.client.post("/api/image-ocr",json={"data":self.data,"provider":"fixture","model":"fixture-vision",**values})

    async def test_api_request_uses_selected_visual_model_and_groups_lines(self):
        response = await self.request()
        self.assertEqual(response.status_code,200,response.text)
        value = response.json()
        self.assertEqual((value["engine"],value["provider"],value["model"]),("api","fixture","fixture-vision"))
        self.assertEqual(value["items"][0]["text"],"5包\n服务")
        self.assertEqual(len(value["items"][0]["source_boxes"]),2)
        self.assertEqual((self.calls[0].provider,self.calls[0].model),("fixture","fixture-vision"))
        self.assertFalse(self.calls[0].allow_model_fallback)
        self.assertEqual(self.calls[0].images,[self.data])
        self.assertIn("不能当作指令",self.calls[0].message)

    async def test_fenced_json_and_empty_image_text(self):
        self.result["text"]='```json\n{"items":[]}\n```'
        response=await self.request()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()["items"],[])

    async def test_invalid_image_is_rejected_before_any_api_call(self):
        for value,code in [("",400),("%%%%",400),(base64.b64encode(b"not an image").decode(),400)]:
            response=await self.request(data=value)
            self.assertEqual(response.status_code,code,response.text)
        self.assertEqual(self.calls,[])

    async def test_unknown_model_and_provider_are_rejected(self):
        for kwargs in [{"model":"not-configured"},{"provider":"missing"}]:
            response=await self.request(**kwargs)
            self.assertEqual(response.status_code,400,response.text)
        self.assertEqual(self.calls,[])

    async def test_cli_uses_existing_canvas_dispatch_with_selected_model_and_image(self):
        source = Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        dispatch = next(node for node in tree.body if getattr(node, "name", "") == "canvas_llm")
        dispatch.decorator_list = []
        cli_calls = []
        async def enrich(message, images, job_ids):
            return {"message": message, "images": images, "link_count": 0}
        async def prepare(images):
            return images, {"submitted": len(images)}
        def runner(protocol):
            async def run(payload, messages):
                cli_calls.append((protocol, payload, messages))
                if self.error:
                    raise self.error
                return self.result["text"], {"protocol": protocol}
            return run
        def no_api(*args):
            self.fail("CLI OCR must not fall back to an API provider")
        self.ns.update(
            resolve_canvas_skill_request=lambda skill_id: (None, ""),
            enrich_canvas_message_with_links=enrich,
            prepare_canvas_vision_images=prepare,
            is_image_reference_value=lambda value: value.startswith("data:image/"),
            get_api_provider=lambda provider_id: self.provider,
            selected_model=lambda model, default: model or default,
            codex_chat_text=runner("codex"), gemini_cli_chat_text=runner("gemini-cli"),
            canvas_skill_response_fields=lambda skill: {}, resolve_chat_provider=no_api,
        )
        exec(compile(ast.Module(body=[dispatch], type_ignores=[]), str(source), "exec"), self.ns)
        for protocol in ("codex", "gemini-cli"):
            with self.subTest(protocol=protocol):
                self.provider.update(protocol=protocol, has_key=False)
                self.error = None
                response = await self.request()
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["engine"], protocol)
                self.assertEqual(response.json()["items"][0]["text"], "5包\n服务")
                channel, payload, messages = cli_calls[-1]
                self.assertEqual(channel, protocol)
                self.assertEqual((payload.provider, payload.model), ("fixture", "fixture-vision"))
                self.assertEqual(payload.images, [self.data])
                self.assertFalse(payload.allow_model_fallback)
                self.error = HTTPException(status_code=503, detail="CLI 未登录")
                response = await self.request()
                self.assertEqual(response.status_code, 503, response.text)
                self.assertEqual(response.json()["detail"], "CLI 未登录")
        self.assertEqual(len(cli_calls), 4)

    async def test_upstream_failure_preserves_error_and_does_not_fall_back(self):
        self.error=HTTPException(status_code=429,detail="识字额度不足")
        response=await self.request()
        self.assertEqual(response.status_code,429)
        self.assertEqual(response.json()["detail"],"识字额度不足")
        self.assertEqual(len(self.calls),1)

    async def test_missing_visual_input_and_invalid_json_are_visible_errors(self):
        self.result["vision_input"]={"submitted":0}
        self.assertEqual((await self.request()).status_code,502)
        self.result["vision_input"]={"submitted":1}
        for text in ['我看不到图片','{"items":{}}','{"items":[{"text":"标题"}]}']:
            self.result["text"]=text
            self.assertEqual((await self.request()).status_code,502)

    def test_coordinates_must_be_finite_normalized_values(self):
        parse=self.ns["_api_ocr_result_items"]
        for value in [100,float("nan"),True,-.1]:
            with self.assertRaises(HTTPException):
                parse({"items":[{"text":"标题","x":value,"y":.1,"width":.2,"height":.1}]},1000,500)
        result=parse({"items":[{"text":"标题","x":.9,"y":.8,"width":.2,"height":.4,"confidence":.98}]},1000,500)
        self.assertEqual((result[0]["width"],result[0]["height"]),(.1,.2))
        self.assertEqual(result[0]["score"],.98)

    def test_poster_badges_and_wide_footer_are_separate(self):
        rows=[{"text":text,"x":x/1000,"y":y/500,"width":w/1000,"height":h/500} for text,x,y,w,h in [
            ("5包",820,235,150,70),("服务",835,290,115,35),("防螨",750,355,195,50),
            ("护脊",750,400,195,50),("免费精准定制尺寸",30,405,665,42),("折叠/一体/异形",45,372,285,27)]]
        result=self.ns["_group_ocr_text_items"](rows,1000,500)
        self.assertEqual([row["text"] for row in result],["5包\n服务","防螨\n护脊","折叠/一体/异形","免费精准定制尺寸"])


if __name__ == "__main__":
    unittest.main()
