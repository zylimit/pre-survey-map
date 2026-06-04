"""Pytest configuration for backend tests."""

import sys
from pathlib import Path


API_ROOT = Path(__file__).resolve().parent
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: 连真库的集成测试")
