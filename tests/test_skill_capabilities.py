import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import skill_capabilities as capabilities
from agent_skill_store import frontmatter_value

PACKAGES_DIR = REPO_ROOT / "data" / "agent_skills" / "packages"
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
    def setUp(self):
        self.skill_dirs = sorted(
            item for item in PACKAGES_DIR.iterdir()
            if item.is_dir() and not item.name.startswith(".")
        )

    def test_bundled_skill_packages_exist(self):
        self.assertTrue(self.skill_dirs)

    def test_every_bundled_skill_declares_known_capabilities(self):
        mapping = load_generator().SKILL_CAPABILITIES
        for skill_dir in self.skill_dirs:
            skill_file = skill_dir / "SKILL.md"
            self.assertTrue(skill_file.is_file(), skill_dir.name)
            text = skill_file.read_text(encoding="utf-8-sig")
            self.assertTrue(text.startswith("---"), skill_dir.name)
            meta = text.split("---", 2)[1]
            declared = capabilities.parse_capability_ids(meta)
            self.assertTrue(declared, f"{skill_dir.name} 缺少 capabilities 声明")
            self.assertEqual(capabilities.unknown_capability_ids(declared), [], skill_dir.name)
            self.assertEqual(declared, mapping[skill_dir.name], skill_dir.name)

    def test_generator_mapping_only_uses_registered_identifiers(self):
        generator = load_generator()
        for skill_id, ids in list(generator.SKILL_CAPABILITIES.items()) + list(generator.LEGACY_SKILL_CAPABILITIES.items()):
            self.assertEqual(capabilities.unknown_capability_ids(ids), [], skill_id)
            self.assertTrue(ids, skill_id)

    def test_legacy_single_file_skills_declare_known_capabilities(self):
        generator = load_generator()
        legacy_files = sorted(PACKAGES_DIR.parent.glob("*.md"))
        self.assertTrue(legacy_files)
        for legacy_file in legacy_files:
            text = legacy_file.read_text(encoding="utf-8-sig")
            self.assertTrue(text.startswith("---"), legacy_file.name)
            meta = text.split("---", 2)[1]
            declared = capabilities.parse_capability_ids(meta)
            self.assertTrue(declared, f"{legacy_file.name} 缺少 capabilities 声明")
            self.assertEqual(capabilities.unknown_capability_ids(declared), [], legacy_file.name)
            skill_id = str(frontmatter_value(meta, "name") or "").strip()
            self.assertIn(skill_id, generator.LEGACY_SKILL_CAPABILITIES, legacy_file.name)
            self.assertEqual(declared, generator.LEGACY_SKILL_CAPABILITIES[skill_id], legacy_file.name)

    def test_declared_identifiers_keep_the_original_document_intact(self):
        for skill_dir in self.skill_dirs:
            text = (skill_dir / "SKILL.md").read_text(encoding="utf-8-sig")
            self.assertIn("#", text, skill_dir.name)
            meta = text.split("---", 2)[1]
            top_level = [
                line for line in meta.splitlines()
                if line.startswith("capabilities")
            ]
            self.assertEqual(len(top_level), 1, skill_dir.name)


class AgentSkillCapabilityApiTests(unittest.TestCase):
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
