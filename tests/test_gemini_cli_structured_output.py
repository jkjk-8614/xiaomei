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

    def test_fenced_json_and_normal_prose_are_preserved(self):
        for answer in ('```json\n{"layers":[]}\n```', '图片里有家具。'):
            _, text = main.gemini_cli_parse_stdout(answer, unwrap_envelope=False)
            self.assertEqual(text, answer)


if __name__ == '__main__':
    unittest.main()
