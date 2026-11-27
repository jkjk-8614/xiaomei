import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

import main


SESSION_START_ERROR = b'error: failed to start conversation: backend returned an empty conversation id'


class GeminiCliStructuredOutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_antigravity_preserves_model_json_including_text_named_fields(self):
        for answer in ({'layers':[{'id':'layer-1','name':'背景'}], 'elements':[]},
                       {'text':'一段文字', 'layers':[]}, {'layers':[], 'pass':True}):
            stdout = json.dumps(answer, ensure_ascii=False)
            proc = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(stdout.encode(), b'')))
            with patch.object(main, 'gemini_cli_executable', return_value='agy.exe'), \
                 patch.object(main.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=proc)):
                result = await main.run_gemini_cli('只返回 JSON')
            self.assertEqual(json.loads(result['text']), answer)

    async def test_canvas_llm_recovers_after_cli_cannot_create_a_conversation(self):
        model = 'gemini-4-neon-xhigh'
        answer = {'screens': [{'title': '首屏', 'prompt': '展示商品'}]}
        stdout = json.dumps({'conversation_id': 'ready', 'status': 'SUCCESS', 'response': json.dumps(answer)})
        start = AsyncMock()
        collect = AsyncMock(side_effect=[(1, b'', SESSION_START_ERROR), (0, stdout.encode(), b'')])
        provider = {'id': 'gemini-cli', 'protocol': 'gemini-cli', 'chat_models': [model]}
        transport = httpx.ASGITransport(app=main.app, client=('127.0.0.1', 50000))
        async with httpx.AsyncClient(transport=transport, base_url='http://127.0.0.1:3000') as client:
            with (
                patch.object(main, 'get_api_provider', return_value=provider),
                patch.object(main, 'gemini_cli_executable', return_value='agy.exe'),
                patch.object(main.cli_process, 'start', start),
                patch.object(main.cli_process, 'collect', collect),
            ):
                response = await client.post('/api/canvas-llm', json={
                    'provider': 'gemini-cli', 'model': model, 'message': '请生成分屏提示词', 'cli_timeout': 600,
                })
        payload = response.raise_for_status().json()
        self.assertEqual(json.loads(payload['text']), answer)
        self.assertEqual(payload['model'], model)
        self.assertEqual(start.await_count, 2)
        first, retry = [call.args[0] for call in start.await_args_list]
        self.assertEqual(first[1:3], ['--print-timeout', '600s'])
        self.assertLess(collect.await_args_list[1].args[1], collect.await_args_list[0].args[1] - 2)
        self.assertEqual(first[3:], retry[3:])
        self.assertEqual(first[-2], '-p')
        self.assertIn('请生成分屏提示词', first[-1])

    async def test_cli_limits_retries_to_the_remaining_budget(self):
        for timeout, launch_count in ((2, 1), (100, 4)):
            with (
                self.subTest(timeout=timeout),
                patch.object(main, 'gemini_cli_executable', return_value='agy.exe'),
                patch.object(main.cli_process, 'start', new_callable=AsyncMock) as start,
                patch.object(main.cli_process, 'collect', new=AsyncMock(return_value=(1, b'', SESSION_START_ERROR))),
                patch.object(main.asyncio, 'sleep', new_callable=AsyncMock) as sleep,
            ):
                with self.assertRaises(main.HTTPException) as error:
                    await main.run_gemini_cli('测试', timeout=timeout)
                self.assertEqual(error.exception.status_code, 502)
                self.assertIn('暂时无法创建会话', error.exception.detail)
                self.assertEqual(start.await_count, launch_count)
                self.assertEqual(sleep.await_count, launch_count - 1)

    async def test_cli_does_not_retry_other_errors_or_a_different_cli(self):
        for executable, stderr in (('agy.exe', b'model quota exceeded'), ('gemini.cmd', SESSION_START_ERROR)):
            with (
                self.subTest(executable=executable),
                patch.object(main, 'gemini_cli_executable', return_value=executable),
                patch.object(main.cli_process, 'start', new_callable=AsyncMock) as start,
                patch.object(main.cli_process, 'collect', new=AsyncMock(return_value=(1, b'', stderr))),
            ):
                with self.assertRaises(main.HTTPException) as error:
                    await main.run_gemini_cli('测试')
                self.assertEqual(error.exception.status_code, 502)
                self.assertIn(stderr.decode(), error.exception.detail)
                start.assert_awaited_once()

    def test_legacy_gemini_envelope_still_unwraps_response(self):
        answer = '{"layers":[],"elements":[]}'
        raw, text = main.gemini_cli_parse_stdout(json.dumps({'response':answer, 'stats':{}}))
        self.assertEqual(text, answer)

    def test_empty_envelope_response_does_not_leak_cli_metadata(self):
        raw, text = main.gemini_cli_parse_stdout(json.dumps({
            'conversation_id': 'turn-123',
            'status': 'SUCCESS',
            'response': '',
            'denied_actions': [{'action': 'read_file', 'display_name': 'ViewFile'}],
        }))
        self.assertEqual(text, '')
        self.assertEqual(raw['status'], 'SUCCESS')

    def test_legacy_metadata_artifact_is_not_sent_back_as_chat_history(self):
        payload = main.ChatRequest(message='继续分析')
        prompt, _images = main.gemini_cli_chat_prompt(payload, [{
            'role': 'assistant',
            'content': '530bc561-46aa-46d1-8c64-e1c3c8859bb5\nSUCCESS\nread_file\nViewFile',
        }])
        self.assertNotIn('ViewFile', prompt)

    def test_fenced_json_and_normal_prose_are_preserved(self):
        for answer in ('```json\n{"layers":[]}\n```', '图片里有家具。'):
            _, text = main.gemini_cli_parse_stdout(answer, unwrap_envelope=False)
            self.assertEqual(text, answer)

    async def test_chat_reference_images_allow_antigravity_to_read_attachment(self):
        payload = main.ChatRequest(message='请分析这张图', reference_images=[main.AIReference(url='file:///tmp/reference.jpg')])
        cli_call = AsyncMock(return_value={'text': '图片分析完成', 'raw': {}, '_stderr': ''})
        with patch.object(main, 'gemini_cli_reference_paths', new=AsyncMock(return_value=(['C:/tmp/reference.jpg'], []))), \
                patch.object(main, 'run_gemini_cli', new=cli_call):
            text, _raw = await main.gemini_cli_chat_text(payload, [])
        self.assertEqual(text, '图片分析完成')
        self.assertTrue(cli_call.call_args.kwargs['allow_tools'])


if __name__ == '__main__':
    unittest.main()
