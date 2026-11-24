import asyncio
import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import skill_capabilities as capabilities
from agent_skill_store import frontmatter_value

GENERATOR = REPO_ROOT / "tools" / "skill-capabilities" / "apply.py"


def load_generator():
    spec = importlib.util.spec_from_file_location("skill_capability_generator", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CapabilityParserTests(unittest.TestCase):
    def test_flow_list_is_read(self):
        meta = "name: x\ncapabilities: [model.image, tool.1688.search]"
        self.assertEqual(capabilities.parse_capability_ids(meta), ["model.image", "tool.1688.search"])

    def test_block_list_is_read(self):
        meta = "name: x\ncapabilities:\n  - model.image\n  - model.video\n"
        self.assertEqual(capabilities.parse_capability_ids(meta), ["model.image", "model.video"])

    def test_nested_capability_key_is_ignored(self):
        meta = "name: x\ncompatibility:\n  capabilities: [wrong.nested]\ncapabilities: [model.image]"
        self.assertEqual(capabilities.parse_capability_ids(meta), ["model.image"])

    def test_duplicates_are_removed_and_order_is_kept(self):
        meta = "capabilities: [model.image, model.image, host.agent]"
        self.assertEqual(capabilities.parse_capability_ids(meta), ["model.image", "host.agent"])

    def test_missing_declaration_yields_no_identifiers(self):
        self.assertEqual(capabilities.parse_capability_ids("name: x\ndescription: y"), [])
        self.assertEqual(capabilities.parse_capability_ids(""), [])

    def test_unknown_identifiers_are_reported_not_dropped(self):
        self.assertEqual(
            capabilities.unknown_capability_ids(["model.image", "typo.capability"]),
            ["typo.capability"],
        )


class CapabilityRegistryTests(unittest.TestCase):
    def test_every_namespace_is_declared_and_used(self):
        used = {item.split(".", 1)[0] for item in capabilities.CAPABILITY_REGISTRY}
        self.assertEqual(used, set(capabilities.CAPABILITY_NAMESPACES))

    def test_identifiers_are_namespaced_and_labelled(self):
        for capability_id, entry in capabilities.CAPABILITY_REGISTRY.items():
            self.assertIn(".", capability_id, capability_id)
            self.assertTrue(entry["label"], capability_id)
            self.assertTrue(entry["summary"], capability_id)

    def test_probes_only_reference_registered_capabilities(self):
        for capability_id in capabilities.CAPABILITY_PROBES:
            self.assertIn(capability_id, capabilities.CAPABILITY_REGISTRY)

    def test_catalog_exposes_every_capability(self):
        catalog = capabilities.capability_catalog()
        self.assertEqual(len(catalog), len(capabilities.CAPABILITY_REGISTRY))
        self.assertTrue(all(item["label"] and item["namespace_label"] for item in catalog))


class CapabilityEvaluationTests(unittest.TestCase):
    def test_probed_capability_reports_availability(self):
        result = capabilities.evaluate_capabilities(["model.image"], {"model_image": True})
        self.assertEqual(result[0]["available"], True)
        result = capabilities.evaluate_capabilities(["model.image"], {"model_image": False})
        self.assertEqual(result[0]["available"], False)

    def test_undetected_capability_is_never_reported_as_available(self):
        result = capabilities.evaluate_capabilities(["model.image", "tool.1688.search"], {})
        self.assertEqual([item["available"] for item in result], [None, None])

    def test_unknown_identifier_is_flagged(self):
        result = capabilities.evaluate_capabilities(["typo.capability"], {})
        self.assertIsNone(result[0]["available"])
        self.assertIn("未登记", result[0]["reason"])


class SkillPackageDeclarationTests(unittest.TestCase):
    body = "\n# Skill fixture\n\nSample instructions.\n"

    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        cls.root = Path(directory.name)
        cls.generator = load_generator()
        cls.packages = {
            skill_id: cls.root / "packages" / skill_id / "SKILL.md"
            for skill_id in cls.generator.SKILL_CAPABILITIES
        }
        cls.legacy = {
            skill_id: cls.root / f"{skill_id}.md"
            for skill_id in cls.generator.LEGACY_SKILL_CAPABILITIES
        }
        for skill_id, path in [*cls.packages.items(), *cls.legacy.items()]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"---\nname: {skill_id}\n---{cls.body}", encoding="utf-8")
        argv = [str(GENERATOR), "--apply", "--packages-dir", str(cls.root / "packages"),
                "--backup-dir", str(cls.root / "backup")]
        with patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()) as output:
            result = cls.generator.main()
        if result:
            raise AssertionError(output.getvalue())

    def test_generator_accepts_the_result_in_check_mode(self):
        argv = [str(GENERATOR), "--check", "--packages-dir", str(self.root / "packages")]
        with patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.generator.main(), 0, output.getvalue())

    def test_generated_packages_declare_known_capabilities(self):
        for skill_id, skill_file in self.packages.items():
            text = skill_file.read_text(encoding="utf-8-sig")
            meta, _, _ = self.generator.split_document(text)
            declared = capabilities.parse_capability_ids(meta)
            self.assertEqual(capabilities.unknown_capability_ids(declared), [], skill_id)
            self.assertEqual(declared, self.generator.SKILL_CAPABILITIES[skill_id], skill_id)

    def test_generator_mapping_only_uses_registered_identifiers(self):
        generator = self.generator
        for skill_id, ids in list(generator.SKILL_CAPABILITIES.items()) + list(generator.LEGACY_SKILL_CAPABILITIES.items()):
            self.assertEqual(capabilities.unknown_capability_ids(ids), [], skill_id)
            self.assertTrue(ids, skill_id)

    def test_legacy_single_file_skills_declare_known_capabilities(self):
        for skill_id, legacy_file in self.legacy.items():
            text = legacy_file.read_text(encoding="utf-8-sig")
            meta, _, _ = self.generator.split_document(text)
            declared = capabilities.parse_capability_ids(meta)
            self.assertEqual(frontmatter_value(meta, "name"), skill_id)
            self.assertEqual(declared, self.generator.LEGACY_SKILL_CAPABILITIES[skill_id], skill_id)

    def test_declared_identifiers_keep_the_original_document_intact(self):
        for skill_id, path in [*self.packages.items(), *self.legacy.items()]:
            meta, body, _ = self.generator.split_document(path.read_text(encoding="utf-8-sig"))
            self.assertEqual(body, self.body, skill_id)
            self.assertEqual(sum(line.startswith("capabilities:") for line in meta.splitlines()), 1, skill_id)


class AgentSkillCapabilityApiTests(unittest.TestCase):
    def setUp(self):
        import main
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        paths = patch.multiple(
            main,
            AGENT_SKILLS_DIR=str(root),
            AGENT_SKILL_PACKAGES_DIR=str(root / "packages"),
            AGENT_SKILL_PACKAGE_INDEX_FILE=str(root / "package-index.json"),
        )
        paths.start()
        self.addCleanup(paths.stop)
        (root / "minimal-skill.md").write_text(
            "---\nname: minimal-skill\ncapabilities: [model.image]\n---\nSample instructions.\n",
            encoding="utf-8",
        )

    def test_main_parser_reports_unknown_identifiers(self):
        import main

        info = main.parse_agent_skill_capabilities("capabilities: [model.image, typo.capability]")
        self.assertEqual(info["ids"], ["model.image", "typo.capability"])
        self.assertEqual(info["unknown"], ["typo.capability"])
        self.assertEqual(
            info["labels"],
            capabilities.capability_labels(["model.image", "typo.capability"]),
        )

    def test_legacy_skill_without_declaration_still_loads(self):
        import main

        record = {
            "id": "minimal-skill",
            "kind": "legacy",
            "compatibility": main.parse_agent_skill_compatibility(""),
            "capability_ids": main.parse_agent_skill_capabilities("name: minimal-skill")["ids"],
            "capabilities": ["对话指令"],
        }
        self.assertEqual(record["capability_ids"], [])
        self.assertEqual(record["capabilities"], ["对话指令"])

    def test_skill_listing_exposes_capability_contract(self):
        import main
        from fastapi import Response

        payload = asyncio.run(main.get_agent_skills(Response()))
        self.assertIn("capability_catalog", payload)
        self.assertTrue(payload["capability_catalog"])
        self.assertEqual(payload["capability_contract_version"], capabilities.CAPABILITY_CONTRACT_VERSION)

        skills = payload["skills"]
        self.assertTrue(skills)
        declared = [item for item in skills if item.get("capability_ids")]
        self.assertTrue(declared)
        for item in declared:
            self.assertEqual(
                len(item["capability_status"]),
                len(item["capability_ids"]),
                item.get("id"),
            )
            self.assertEqual(
                [entry["id"] for entry in item["capability_status"]],
                item["capability_ids"],
            )

    def test_capability_endpoint_lists_every_skill(self):
        import main
        from fastapi import Response

        payload = asyncio.run(main.get_agent_skill_capabilities(Response()))
        self.assertEqual(payload["contract_version"], capabilities.CAPABILITY_CONTRACT_VERSION)
        self.assertTrue(payload["catalog"])
        self.assertTrue(payload["skills"])
        for skill_id, status in payload["skills"].items():
            self.assertTrue(skill_id)
            self.assertIsInstance(status, list)
            for entry in status:
                self.assertIn("available", entry)
                self.assertIn("id", entry)


if __name__ == "__main__":
    unittest.main()
