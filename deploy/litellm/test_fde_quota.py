import concurrent.futures
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


if __name__ == "__main__":
    unittest.main()
