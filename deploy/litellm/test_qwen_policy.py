import copy
import os
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import fde_quota
from fde_quota import FdeQuota, QuotaLedger, QWEN_MODEL, apply_qwen_output_policy


class QwenPolicyTests(unittest.TestCase):
    def test_chat_disables_reasoning_and_preserves_unrelated_parameters(self):
        data = {"model": QWEN_MODEL, "max_tokens": 4096, "stream": True,
                "tools": [{"type": "function"}], "temperature": 0,
                "chat_template_kwargs": {"preserve_thinking": False},
                "extra_body": {"thinking_token_budget": 999999, "reasoning_effort": "high", "top_p": 1, "top_k": 20}}
        apply_qwen_output_policy(data, "chat", 4096)
        self.assertEqual(data["chat_template_kwargs"], {"enable_thinking": False, "preserve_thinking": False})
        self.assertEqual(data["extra_body"], {"top_k": 20})
        self.assertEqual((data["temperature"], data["top_p"], data["presence_penalty"]), (0.7, 0.8, 1.5))
        self.assertEqual(data["max_tokens"], 4096)
        self.assertTrue(data["stream"])
        self.assertEqual(data["tools"], [{"type": "function"}])
        self.assertNotIn("thinking_token_budget", data)

    def test_work_budget_keeps_answer_headroom_and_explicit_non_thinking(self):
        for limit, expected in [(8192, 1024), (4096, 1024), (512, 128), (128, 32)]:
            data = {"model": QWEN_MODEL, "thinking_token_budget": 999999,
                    "extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}
            apply_qwen_output_policy(data, "work", limit)
            self.assertEqual(data["thinking_token_budget"], expected)
            self.assertEqual(data["chat_template_kwargs"], {"enable_thinking": False})
        data = {"model": QWEN_MODEL}
        apply_qwen_output_policy(data, None, 32)
        self.assertFalse(data["chat_template_kwargs"]["enable_thinking"])
        self.assertNotIn("thinking_token_budget", data)

    def test_default_work_does_not_override_router_vision_default(self):
        data = {"model": QWEN_MODEL}
        apply_qwen_output_policy(data, None, 4096)
        self.assertEqual(data["thinking_token_budget"], 1024)
        self.assertNotIn("chat_template_kwargs", data)

    def test_other_models_are_unchanged(self):
        for model in ["enterprise-main", "fde-station-deepseek-flash"]:
            data = {"model": model, "reasoning_effort": "high", "extra_body": {"thinking_token_budget": 3000}}
            before = copy.deepcopy(data)
            apply_qwen_output_policy(data, "chat", 4096)
            self.assertEqual(data, before)

    def test_invalid_extensions_fail_before_quota_reservation(self):
        for extra in [[], "bad", {"chat_template_kwargs": "bad"}]:
            data = {"model": QWEN_MODEL, "extra_body": extra}
            with self.assertRaises(fde_quota.HTTPException):
                apply_qwen_output_policy(data, "chat", 4096)


class QwenHookTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_trusted_key_mode_controls_policy_and_usage_still_settles(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fde_quota, "TEAM", "fde-team"):
            ledger = QuotaLedger(os.path.join(directory, "quota.db"))
            hook = FdeQuota(ledger)
            user_id = str(uuid.uuid4())
            key = SimpleNamespace(team_id="fde-team", metadata={"fde_id": user_id, "mode": "work"})
            data = {"model": QWEN_MODEL, "messages": [{"role": "user", "content": "long question"}],
                    "max_tokens": 4096, "metadata": {"mode": "chat"}}
            result = await hook.async_pre_call_hook(key, None, data, "acompletion")
            self.assertEqual(result["thinking_token_budget"], 1024)
            self.assertEqual(result["max_tokens"], 4096)
            self.assertGreaterEqual(ledger.snapshot(user_id)["reserved"], 4096)
            await hook.record(result["metadata"], {"usage": {"total_tokens": 123}})
            self.assertEqual(ledger.snapshot(user_id)["used"], 123)
            self.assertEqual(ledger.snapshot(user_id)["reserved"], 0)
            key.metadata["mode"] = "chat"
            result = await hook.async_pre_call_hook(key, None, copy.deepcopy(data), "acompletion")
            self.assertFalse(result["chat_template_kwargs"]["enable_thinking"])

    async def test_other_team_does_not_receive_policy_or_reservation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fde_quota, "TEAM", "fde-team"):
            ledger = QuotaLedger(os.path.join(directory, "quota.db"))
            data = {"model": QWEN_MODEL, "metadata": {"mode": "chat"}}
            before = copy.deepcopy(data)
            key = SimpleNamespace(team_id="other", metadata={})
            self.assertEqual(await FdeQuota(ledger).async_pre_call_hook(key, None, data, "acompletion"), before)


if __name__ == "__main__":
    unittest.main()
