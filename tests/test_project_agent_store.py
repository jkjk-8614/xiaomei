import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from project_agent_store import AgentStateError, ProjectAgentStore


class ProjectAgentStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ProjectAgentStore(self.temp.name)

    def test_project_isolation_and_reopen(self):
        self.store.add_memory('project_a', 'constraint', '相框比例保持不变', 'canvas_a')
        self.assertEqual(self.store.read('project_b')['memories'], [])
        reopened = ProjectAgentStore(self.temp.name)
        self.assertEqual(reopened.read('project_a')['memories'][0]['text'], '相框比例保持不变')
        self.assertEqual(reopened.read('project_b')['memories'], [])

    def test_concurrent_adds_and_stale_edit(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda n: self.store.add_memory('project_a', 'todo', f'待办 {n}'), range(40)))
        state = self.store.read('project_a')
        self.assertEqual(len(state['memories']), 40)
        memory = state['memories'][0]
        self.store.edit_memory('project_a', memory['id'], 1, '已修改')
        with self.assertRaises(AgentStateError) as error:
            self.store.edit_memory('project_a', memory['id'], 1, '旧窗口覆盖')
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.read('project_a')['memories'][0]['text'], '已修改')

    def test_reset_only_current_project_and_preserves_settings(self):
        self.store.add_memory('project_a', 'goal', '做详情页')
        self.store.add_memory('project_b', 'goal', '做主图')
        self.store.update('project_a', lambda state: state['settings'].update(paused=True))
        self.store.reset('project_a')
        self.assertEqual(self.store.read('project_a')['memories'], [])
        self.assertTrue(self.store.read('project_a')['settings']['paused'])
        self.assertEqual(len(self.store.read('project_b')['memories']), 1)

    def test_global_switch_has_revision_and_covers_all_projects(self):
        self.assertTrue(self.store.read_global()['enabled'])
        self.store.set_global(False, 0)
        self.assertFalse(ProjectAgentStore(self.temp.name).read_global()['enabled'])
        with self.assertRaises(AgentStateError) as error:
            self.store.set_global(True, 0)
        self.assertEqual(error.exception.status, 409)

    def test_bad_id_and_corrupt_file_never_overwrite(self):
        with self.assertRaises(AgentStateError):
            self.store.add_memory('../project_b', 'goal', '无效路径')
        file = Path(self.temp.name) / 'project_agent' / 'project_a' / 'state.json'
        file.parent.mkdir(parents=True)
        file.write_text('{broken', encoding='utf-8')
        with self.assertRaises(AgentStateError) as error:
            self.store.add_memory('project_a', 'goal', '不能覆盖')
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(file.read_text(encoding='utf-8'), '{broken')
        malformed = '{"project_id":"project_a","revision":0,"memories":{},"settings":{}}'
        file.write_text(malformed, encoding='utf-8')
        with self.assertRaises(AgentStateError) as error:
            self.store.add_memory('project_a', 'goal', '不能覆盖')
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(file.read_text(encoding='utf-8'), malformed)


if __name__ == '__main__':
    unittest.main()
