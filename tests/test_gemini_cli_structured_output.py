import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import main


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
