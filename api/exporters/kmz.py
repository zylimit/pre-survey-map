"""KMZ 生成器。

按 Spec「KML / KMZ 处理」节硬要求：
- 三个 Schema：site / road / lessor，字段与示例 Integrated_Libraries_*.kml 对齐
- 7 个 Style 定义直接抄示例文件（point-green/yellow/red、poly-green/yellow/red、line-brown）
- Folder 分组：Site 下 Positive/Negative/Unknown；Lessor 下 Friendly/Normal/Unfriendly
- 字段名规范化：`Lessor Cagegory`（错拼）→ `Lessor Category`（Spec 字段名兼容节）
- extras JSONB 全部展开成 SchemaData/SimpleData（Spec：不能丢字段）
"""

import io
import json
import zipfile
from typing import Any, Iterable
from xml.sax.saxutils import escape

# 强类型核心字段；这些会从行的列里写，不从 extras 里写（避免重复 + 类型损失）
SITE_RESERVED = {"PROJECT", "SITE ID", "OPTION", "SITE STATUS", "LATI", "LONGI"}
LESSOR_RESERVED = {
    "fid", "Lessor Name", "Lessor Category", "Lessor Cagegory", "Relationship",
}
ROAD_RESERVED = {"Property"}

SITE_CORE_FIELDS = ["PROJECT", "SITE ID", "OPTION", "SITE STATUS", "LATI", "LONGI"]
LESSOR_CORE_FIELDS = ["fid", "Lessor Name", "Lessor Category", "Relationship"]
ROAD_CORE_FIELDS = ["Property"]

# Style ID 选择规则
SITE_STATUS_STYLE = {
    "positive": ("point-green", "Positive"),
    "negative": ("point-yellow", "Negative"),
}
LESSOR_REL_STYLE = {
    "friendly": ("poly-green", "Friendly"),
    "normal": ("poly-yellow", "Normal"),
    "unfriendly": ("poly-red", "Unfriendly"),
}


def fmt_float(v: Any) -> str:
    """LATI / LONGI 等浮点写出 KML 时，避免 1e-06 这种科学计数。"""
    if v is None:
        return ""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    s = f"{f:.7f}".rstrip("0").rstrip(".")
    return s if s else "0"


def esc(v: Any) -> str:
    """XML 文本转义；None / 空都返回空串。"""
    if v is None:
        return ""
    return escape(str(v))


def _parse_extras(extras: Any) -> dict[str, Any]:
    if extras is None:
        return {}
    if isinstance(extras, str):
        try:
            return json.loads(extras)
        except json.JSONDecodeError:
            return {}
    if isinstance(extras, dict):
        return extras
    return {}


# ---------- Schema ----------


def _schema(name: str, fields: list[str]) -> str:
    parts = [f'<Schema name="{name}" id="{name}">']
    for f in fields:
        parts.append(f'  <SimpleField name="{esc(f)}" type="string"></SimpleField>')
    parts.append("</Schema>")
    return "\n".join(parts)


# 7 个 Style，与示例 Integrated_Libraries_*.kml 完全一致
STYLES_KML = """\
<Style id="point-green">
  <IconStyle>
    <color>FFFFFFFF</color>
    <scale>1.2</scale>
    <Icon>
      <href>http://maps.google.com/mapfiles/kml/pushpin/grn-pushpin.png</href>
    </Icon>
  </IconStyle>
</Style>
<Style id="point-yellow">
  <IconStyle>
    <color>FFFFFFFF</color>
    <scale>1.2</scale>
    <Icon>
      <href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href>
    </Icon>
  </IconStyle>
</Style>
<Style id="point-red">
  <IconStyle>
    <color>FFFFFFFF</color>
    <scale>1.2</scale>
    <Icon>
      <href>http://maps.google.com/mapfiles/kml/pushpin/red-pushpin.png</href>
    </Icon>
  </IconStyle>
</Style>
<Style id="poly-green">
  <LineStyle><color>FF00FF00</color><width>2</width></LineStyle>
  <PolyStyle><color>9900FF00</color><fill>1</fill><outline>1</outline></PolyStyle>
</Style>
<Style id="poly-yellow">
  <LineStyle><color>FF00FFFF</color><width>2</width></LineStyle>
  <PolyStyle><color>9900FFFF</color><fill>1</fill><outline>1</outline></PolyStyle>
</Style>
<Style id="poly-red">
  <LineStyle><color>FF0000FF</color><width>2</width></LineStyle>
  <PolyStyle><color>990000FF</color><fill>1</fill><outline>1</outline></PolyStyle>
</Style>
<Style id="line-brown">
  <LineStyle><color>FF8B4513</color><width>4</width></LineStyle>
  <PolyStyle><fill>0</fill></PolyStyle>
</Style>"""


# ---------- Placemark 构造 ----------


def _site_value(row: dict[str, Any], field: str) -> str:
    """按 Schema 字段名取站点的值。优先从强类型列，回落到 extras。"""
    col_map = {
        "PROJECT": row.get("project"),
        "SITE ID": row.get("site_id"),
        "OPTION": row.get("option"),
        "SITE STATUS": row.get("site_status"),
        "LATI": fmt_float(row.get("lati")),
        "LONGI": fmt_float(row.get("longi")),
    }
    if field in col_map:
        return esc(col_map[field])
    return esc(_parse_extras(row.get("extras")).get(field, ""))


def _lessor_value(row: dict[str, Any], field: str) -> str:
    col_map = {
        "fid": row.get("fid"),
        "Lessor Name": row.get("lessor_name"),
        "Lessor Category": row.get("lessor_category"),
        "Relationship": row.get("relationship"),
    }
    if field in col_map:
        return esc(col_map[field])
    return esc(_parse_extras(row.get("extras")).get(field, ""))


def _road_value(row: dict[str, Any], field: str) -> str:
    col_map = {"Property": row.get("property")}
    if field in col_map:
        return esc(col_map[field])
    return esc(_parse_extras(row.get("extras")).get(field, ""))


def _placemark(
    pid: str,
    style_id: str,
    schema_url: str,
    fields: list[str],
    value_fn,
    row: dict[str, Any],
    geom_kml: str,
) -> str:
    """单条 Placemark。fields 是该 schema 的所有 SimpleField name。"""
    parts = [
        f'<Placemark id="{esc(pid)}">',
        f"  <styleUrl>#{style_id}</styleUrl>",
        "  <ExtendedData>",
        f'    <SchemaData schemaUrl="#{schema_url}">',
    ]
    for f in fields:
        v = value_fn(row, f)
        if v == "":
            continue  # 空字段不写
        parts.append(f'      <SimpleData name="{esc(f)}">{v}</SimpleData>')
    parts.append("    </SchemaData>")
    parts.append("  </ExtendedData>")
    parts.append(f"  {geom_kml}")
    parts.append("</Placemark>")
    return "\n".join(parts)


# ---------- Folder 分组 ----------


def _site_bucket(status: Any) -> tuple[str, str]:
    s = (status or "").strip().lower()
    return SITE_STATUS_STYLE.get(s, ("point-red", "Unknown"))


def _lessor_bucket(rel: Any) -> tuple[str, str]:
    r = (rel or "").strip().lower()
    return LESSOR_REL_STYLE.get(r, ("poly-red", "Unfriendly"))


# ---------- Schema 字段集（核心 + extras 并集，去掉 reserved 重叠） ----------


def _collect_extras_keys(rows: Iterable[dict[str, Any]], reserved: set[str]) -> list[str]:
    keys: set[str] = set()
    for r in rows:
        for k in _parse_extras(r.get("extras")).keys():
            if k in reserved:
                continue
            keys.add(k)
    return sorted(keys)


# ---------- 主入口 ----------


def build_kml(
    site_rows: list[dict[str, Any]],
    road_rows: list[dict[str, Any]],
    lessor_rows: list[dict[str, Any]],
) -> str:
    """组装完整 KML 文档（字符串）。每行的 'geom_kml' 字段必须由调用方填好。"""
    site_extras = _collect_extras_keys(site_rows, SITE_RESERVED)
    site_fields = SITE_CORE_FIELDS + site_extras

    road_extras = _collect_extras_keys(road_rows, ROAD_RESERVED)
    road_fields = ROAD_CORE_FIELDS + road_extras

    lessor_extras = _collect_extras_keys(lessor_rows, LESSOR_RESERVED)
    lessor_fields = LESSOR_CORE_FIELDS + lessor_extras

    out = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        '<Document id="root_doc">',
        _schema("site", site_fields),
        _schema("road", road_fields),
        _schema("lessor", lessor_fields),
        STYLES_KML,
    ]

    # ---- Site Library ----
    site_buckets: dict[str, list[str]] = {"Positive": [], "Negative": [], "Unknown": []}
    for i, r in enumerate(site_rows, 1):
        if not r.get("geom_kml"):
            continue
        style_id, bucket = _site_bucket(r.get("site_status"))
        pid = f"site.{esc(bucket)}.{i}"
        site_buckets[bucket].append(
            _placemark(pid, style_id, "site", site_fields, _site_value, r, r["geom_kml"])
        )

    out.append("<Folder><name>Site Library</name>")
    for bucket in ("Positive", "Negative", "Unknown"):
        if not site_buckets[bucket]:
            continue
        out.append(f"  <Folder><name>{bucket}</name>")
        out.extend(site_buckets[bucket])
        out.append("  </Folder>")
    out.append("</Folder>")

    # ---- Road Library（无分组）----
    out.append("<Folder><name>Road Library</name>")
    for i, r in enumerate(road_rows, 1):
        if not r.get("geom_kml"):
            continue
        pid = f"road.{i}"
        out.append(
            _placemark(pid, "line-brown", "road", road_fields, _road_value, r, r["geom_kml"])
        )
    out.append("</Folder>")

    # ---- Lessor Library ----
    lessor_buckets: dict[str, list[str]] = {"Friendly": [], "Normal": [], "Unfriendly": []}
    for i, r in enumerate(lessor_rows, 1):
        if not r.get("geom_kml"):
            continue
        style_id, bucket = _lessor_bucket(r.get("relationship"))
        pid = f"lessor.{esc(bucket)}.{i}"
        lessor_buckets[bucket].append(
            _placemark(pid, style_id, "lessor", lessor_fields, _lessor_value, r, r["geom_kml"])
        )

    out.append("<Folder><name>Lessor Library</name>")
    for bucket in ("Friendly", "Normal", "Unfriendly"):
        if not lessor_buckets[bucket]:
            continue
        out.append(f"  <Folder><name>{bucket}</name>")
        out.extend(lessor_buckets[bucket])
        out.append("  </Folder>")
    out.append("</Folder>")

    out.append("</Document>")
    out.append("</kml>")
    return "\n".join(out)


def pack_kmz(kml_text: str) -> bytes:
    """KML 字符串 → KMZ 字节流（doc.kml 内部命名）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("doc.kml", kml_text.encode("utf-8"))
    return buf.getvalue()
