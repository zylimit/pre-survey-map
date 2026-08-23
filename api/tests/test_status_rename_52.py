"""#52 F24 ③ site_status 拼写纠正回归测试（undermine → undetermined）。

范式：直调 imports.router._norm_site_status 纯函数，无外部依赖、不起 HTTP。
红锁：硬断言 _norm_site_status("Unknown") == "undetermined" 且 != "undermine"，
防未来回退到错拼。
"""

import pytest

from imports.router import _norm_site_status


class TestNormSiteStatusRename:
    def test_unknown_maps_to_undetermined_not_undermine(self):
        # 核心红锁：Unknown 必须映射到正确拼写 undetermined，绝不能是错拼 undermine
        assert _norm_site_status("Unknown") == "undetermined"
        assert _norm_site_status("Unknown") != "undermine"

    @pytest.mark.parametrize("raw", ["Unknown", "unknown", "UNKNOWN", "  Unknown  "])
    def test_unknown_case_and_whitespace_insensitive(self, raw):
        assert _norm_site_status(raw) == "undetermined"

    def test_none_returns_none(self):
        assert _norm_site_status(None) is None

    @pytest.mark.parametrize("raw", ["", "   ", "\t\n"])
    def test_blank_returns_none(self, raw):
        assert _norm_site_status(raw) is None

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Positive", "positive"),
            ("NEGATIVE", "negative"),
            ("undetermined", "undetermined"),
            ("  Positive  ", "positive"),
        ],
    )
    def test_other_values_lowercased_and_passthrough(self, raw, expected):
        assert _norm_site_status(raw) == expected

    def test_source_undetermined_stays_undetermined(self):
        # 源数据本就是正确拼写时，保持不变、不进 Other
        assert _norm_site_status("undetermined") == "undetermined"
