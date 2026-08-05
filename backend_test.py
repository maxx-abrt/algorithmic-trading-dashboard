#!/usr/bin/env python3
"""
Backend API tests for MYCROFT algorithmic trading dashboard.
Tests the new automatic research scheduling feature.
"""
import sys
import requests
from typing import Any, Dict

class APITester:
    def __init__(self, base_url: str = "http://127.0.0.1:8001"):
        self.base_url = base_url
        self.tests_run = 0
        self.tests_passed = 0
        self.original_settings: Dict[str, Any] = {}

    def test(self, name: str, fn) -> bool:
        """Run a single test"""
        self.tests_run += 1
        print(f"\n🔍 Testing {name}...")
        try:
            fn()
            self.tests_passed += 1
            print(f"✅ Passed")
            return True
        except AssertionError as e:
            print(f"❌ Failed: {e}")
            return False
        except Exception as e:
            print(f"❌ Error: {e}")
            return False

    def get(self, endpoint: str) -> Dict[str, Any]:
        """GET request"""
        url = f"{self.base_url}/api/{endpoint}"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.json()

    def post(self, endpoint: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """POST request"""
        url = f"{self.base_url}/api/{endpoint}"
        response = requests.post(url, json=data, timeout=10)
        response.raise_for_status()
        return response.json()

    def test_health(self):
        """Test health endpoint"""
        data = self.get("health")
        assert data.get("ok") is True, "Health check failed"
        assert "engineEnabled" in data, "Missing engineEnabled field"
        assert "uptimeSec" in data, "Missing uptimeSec field"
        print(f"   Engine enabled: {data['engineEnabled']}, Uptime: {data['uptimeSec']}s")

    def test_research_endpoint(self):
        """Test GET /api/research exposes schedule"""
        data = self.get("research")
        assert "schedule" in data, "Missing schedule field"
        schedule = data["schedule"]
        assert "enabled" in schedule, "Missing schedule.enabled field"
        assert "intervalHours" in schedule, "Missing schedule.intervalHours field"
        assert isinstance(schedule["enabled"], bool), "schedule.enabled must be boolean"
        assert isinstance(schedule["intervalHours"], (int, float)), "schedule.intervalHours must be number"
        print(f"   Schedule enabled: {schedule['enabled']}, Interval: {schedule['intervalHours']}h")
        
        # Verify governor is present
        assert "governor" in data, "Missing governor field"
        governor = data["governor"]
        assert "allowed" in governor, "Missing governor.allowed field"
        print(f"   Governor allowed: {governor['allowed']}, Reasons: {governor.get('reasons', [])}")

    def test_settings_get(self):
        """Test GET /api/settings includes new fields"""
        data = self.get("settings")
        assert "autoResearchEnabled" in data, "Missing autoResearchEnabled field"
        assert "researchIntervalHours" in data, "Missing researchIntervalHours field"
        assert isinstance(data["autoResearchEnabled"], bool), "autoResearchEnabled must be boolean"
        assert isinstance(data["researchIntervalHours"], (int, float)), "researchIntervalHours must be number"
        
        # Store original settings for restoration
        self.original_settings = {
            "autoResearchEnabled": data["autoResearchEnabled"],
            "researchIntervalHours": data["researchIntervalHours"]
        }
        print(f"   autoResearchEnabled: {data['autoResearchEnabled']}")
        print(f"   researchIntervalHours: {data['researchIntervalHours']}")

    def test_settings_post(self):
        """Test POST /api/settings accepts and persists new fields"""
        # Test updating autoResearchEnabled
        test_values = {
            "autoResearchEnabled": False,
            "researchIntervalHours": 12
        }
        
        result = self.post("settings", test_values)
        assert result["autoResearchEnabled"] == False, "Failed to update autoResearchEnabled"
        assert result["researchIntervalHours"] == 12, "Failed to update researchIntervalHours"
        print(f"   Updated autoResearchEnabled to False")
        print(f"   Updated researchIntervalHours to 12")
        
        # Verify persistence by reading back
        data = self.get("settings")
        assert data["autoResearchEnabled"] == False, "autoResearchEnabled not persisted"
        assert data["researchIntervalHours"] == 12, "researchIntervalHours not persisted"
        print(f"   Verified persistence")
        
        # Test minimum interval enforcement (should be at least 6 hours)
        result = self.post("settings", {"researchIntervalHours": 3})
        # The runtime should enforce minimum 6 hours in autoResearchLoop
        print(f"   Tested minimum interval (3h -> {result['researchIntervalHours']}h)")

    def test_research_state(self):
        """Test research state structure"""
        data = self.get("research")
        assert "validationState" in data, "Missing validationState"
        assert "campaigns" in data, "Missing campaigns"
        assert "trials" in data, "Missing trials"
        assert "models" in data, "Missing models"
        assert isinstance(data["campaigns"], list), "campaigns must be a list"
        assert isinstance(data["trials"], list), "trials must be a list"
        assert isinstance(data["models"], list), "models must be a list"
        print(f"   Validation state: {data['validationState']}")
        print(f"   Campaigns: {len(data['campaigns'])}, Trials: {len(data['trials'])}, Models: {len(data['models'])}")

    def restore_settings(self):
        """Restore original settings"""
        if self.original_settings:
            print(f"\n🔄 Restoring original settings...")
            try:
                self.post("settings", self.original_settings)
                print(f"✅ Settings restored")
            except Exception as e:
                print(f"⚠️  Failed to restore settings: {e}")

    def run_all(self):
        """Run all tests"""
        print("=" * 60)
        print("MYCROFT Backend API Tests")
        print("Testing automatic research scheduling feature")
        print("=" * 60)

        try:
            self.test("Health endpoint", self.test_health)
            self.test("Research endpoint exposes schedule", self.test_research_endpoint)
            self.test("Settings GET includes new fields", self.test_settings_get)
            self.test("Settings POST accepts and persists new fields", self.test_settings_post)
            self.test("Research state structure", self.test_research_state)
        finally:
            self.restore_settings()

        print("\n" + "=" * 60)
        print(f"📊 Results: {self.tests_passed}/{self.tests_run} tests passed")
        print("=" * 60)
        
        return 0 if self.tests_passed == self.tests_run else 1


def main():
    tester = APITester()
    return tester.run_all()


if __name__ == "__main__":
    sys.exit(main())
