import concurrent.futures
import copy
import base64
import os
import tempfile
import unittest
from fastapi import HTTPException
from fde_quota import QuotaLedger, prompt_upper_bound


class QuotaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, "quota.sqlite3")
        self.ledger = QuotaLedger(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_default_and_user_isolation(self):
        self.assertEqual(self.ledger.snapshot("a")["daily_limit"], 2_000_000)
        r, _ = self.ledger.reserve("a", 100, 200)
        self.ledger.settle(r, 150)
        self.ledger.settle(r, 999)  # duplicate callback cannot charge twice
        self.assertEqual(self.ledger.snapshot("a")["used"], 150)
        self.assertEqual(self.ledger.snapshot("b")["used"], 0)

    def test_concurrent_admission_never_exceeds_limit(self):
        self.ledger.set_limit("a", 1000)
        def reserve(_):
            try:
                return self.ledger.reserve("a", 400, 100)
            except HTTPException as error:
                self.assertEqual(error.status_code, 429)
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            results = list(executor.map(reserve, range(10)))
        self.assertEqual(sum(x is not None for x in results), 2)
        self.assertEqual(self.ledger.snapshot("a")["remaining"], 0)

    def test_restart_and_day_rollover(self):
        self.ledger.set_limit("a", 500)
        reservation, _ = self.ledger.reserve("a", 300, 200)
        other = QuotaLedger(self.path)
        self.assertEqual(other.snapshot("a")["reserved"], 500)
        other.day = lambda: "2099-01-01"
        self.assertEqual(other.snapshot("a")["remaining"], 500)
        other.settle(reservation, 400)
        self.assertEqual(other.snapshot("a")["used"], 0)
        self.assertEqual(self.ledger.snapshot("a")["used"], 400)

    def test_upgrade_keeps_usage_and_zero_disables(self):
        self.ledger.set_limit("a", 1000)
        r, _ = self.ledger.reserve("a", 100, 100)
        self.ledger.settle(r, 150)
        self.ledger.set_limit("a", 2000)
        self.assertEqual(self.ledger.snapshot("a")["remaining"], 1850)
        self.ledger.set_limit("a", 0)
        with self.assertRaises(HTTPException):
            self.ledger.reserve("a", 1, 1)

    def test_invalid_or_missing_usage_preserves_reservation(self):
        r, _ = self.ledger.reserve("a", 100, 100)
        self.ledger.settle(r, None)
        self.assertEqual(self.ledger.snapshot("a")["reserved"], 200)
        with self.assertRaises(HTTPException):
            prompt_upper_bound({"messages":[{"content":[{"type":"image_url"}]}]})

    def test_images_reserve_context_then_settle_actual_usage_without_mutation(self):
        data = {"model":"fde-station-qwen3.8-flash-next", "messages":[{"role":"user","content":[
            {"type":"text","text":"read image"},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,"+base64.b64encode(b"synthetic image").decode()}}
        ]}]}
        before = copy.deepcopy(data)
        bound = prompt_upper_bound(data)
        self.assertEqual(bound,131072)
        self.assertEqual(data,before)
        reservation,_ = self.ledger.reserve("a",bound,512)
        self.assertEqual(self.ledger.snapshot("a")["reserved"],131584)
        self.ledger.settle(reservation,213)
        self.assertEqual(self.ledger.snapshot("a")["used"],213)
        self.assertEqual(self.ledger.snapshot("a")["reserved"],0)
        self.ledger.set_limit("b",131072)
        with self.assertRaises(HTTPException):self.ledger.reserve("b",bound,512)
        data["model"]="unconfigured-model"
        with self.assertRaises(HTTPException):prompt_upper_bound(data)

    def test_rejects_remote_invalid_oversized_images_and_unknown_blocks(self):
        for url in ["http://localhost/private", "data:image/png;base64,###", "data:image/png;base64,", "data:image/png;base64,"+"a"*1398105]:
            with self.assertRaises(HTTPException):
                prompt_upper_bound({"model":"fde-station-qwen3.8-flash-next","messages":[{"content":[{"type":"image_url","image_url":{"url":url}}]}]})
        image={"type":"image_url","image_url":{"url":"data:image/png;base64,eA=="}}
        with self.assertRaises(HTTPException):
            prompt_upper_bound({"model":"fde-station-qwen3.8-flash-next","messages":[{"content":[image]*6}]})
        with self.assertRaises(HTTPException):
            prompt_upper_bound({"messages":[{"content":[{"type":"file","file":{"file_data":"anything"}}]}]})



if __name__ == "__main__":
    unittest.main()
