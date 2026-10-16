import tempfile
import unittest
from unittest.mock import patch

import httpx
import main
from project_agent_store import ProjectAgentStore


class ProjectAgentHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_routes_validate_project_and_keep_analysis_local(self):
        with tempfile.TemporaryDirectory() as directory:
            canvas = {'id':'canvas_a','project':'project_a','updated_at':1,
                      'nodes':[{'id':'photo','type':'smart-upload','images':[{'url':'/assets/example.png'}]}],
                      'connections':[]}
            transport = httpx.ASGITransport(app=main.app, client=('127.0.0.1',12345))
            with patch.object(main,'PROJECT_AGENT_STORE',ProjectAgentStore(directory)), \
                 patch.object(main,'ensure_default_project',return_value=[{'id':'project_a','name':'项目 A'},{'id':'project_b','name':'项目 B'}]), \
                 patch.object(main,'load_canvas',return_value=canvas):
                async with httpx.AsyncClient(transport=transport,base_url='http://127.0.0.1:3000') as client:
                    state = await client.get('/api/project-agent/projects/project_a/state',params={'canvas_id':'canvas_a'})
                    self.assertEqual(state.status_code,200)
                    self.assertEqual(state.json()['memories'],[])
                    result = await client.post('/api/project-agent/analyze',json={
                        'project_id':'project_a','canvas_id':'canvas_a','canvas_revision':1,'trigger':'assets_added'})
                    self.assertEqual(result.status_code,200)
                    self.assertEqual(result.json()['suggestion']['suggestion']['kind'],'local')
                    wrong = await client.get('/api/project-agent/projects/project_b/state',params={'canvas_id':'canvas_a'})
                    self.assertEqual(wrong.status_code,403)
                    visitor = await client.get('/api/project-agent/projects/project_a/state',
                                               headers={'x-xiaomei-share-gateway':'1'})
                    self.assertNotEqual(visitor.status_code,200)


if __name__ == '__main__':
    unittest.main()
