"""坐标异常检测。Spec「数据异常处理」表里的两条规则：

- 坐标漏小数点：LATI 绝对值 > 90，LONGI 绝对值 > 180
- LATI / LONGI 字段写反：LATI 绝对值 > 90 但 LONGI 在合法范围，且两者交换后都合法

入库但标红 + 输出面板警告（实际标红由前端按 warnings 列表渲染）。
"""

from typing import Optional


def detect_coord_warning(lati: Optional[float], longi: Optional[float]) -> Optional[str]:
    if lati is None or longi is None:
        return None
    lat_ok = -90.0 <= lati <= 90.0
    lon_ok = -180.0 <= longi <= 180.0
    if lat_ok and lon_ok:
        return None
    # 写反：LATI 越界但 LONGI 合法；两者交换后都合法
    if not lat_ok and lon_ok:
        if -90.0 <= longi <= 90.0 and -180.0 <= lati <= 180.0:
            return f"LATI/LONGI 疑似写反（LATI={lati}, LONGI={longi}）"
    # 漏小数点：单边超限
    return f"坐标超出合法范围（LATI={lati}, LONGI={longi}）"
