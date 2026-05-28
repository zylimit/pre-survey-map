"""KML parser. 把 KML 字节流解成 site / road / lessor 三类列表。

数据约定：每个 Placemark 用 ExtendedData/SchemaData[@schemaUrl] 标识类型；
缺 schemaUrl 的 Placemark 按几何类型兜底（Point→site / LineString→road / Polygon→lessor）。
"""

from dataclasses import dataclass, field
from typing import Optional

from lxml import etree

NS = {"k": "http://www.opengis.net/kml/2.2"}


@dataclass
class SiteRow:
    site_id: str
    option: str
    project: Optional[str] = None
    site_status: Optional[str] = None
    lati: Optional[float] = None
    longi: Optional[float] = None
    extras: dict = field(default_factory=dict)
    wkt: Optional[str] = None  # POINT(lon lat)


@dataclass
class RoadRow:
    property: Optional[str] = None
    extras: dict = field(default_factory=dict)
    wkt: Optional[str] = None  # LINESTRING(...)


@dataclass
class LessorRow:
    fid: str
    lessor_name: Optional[str] = None
    lessor_category: Optional[str] = None
    relationship: Optional[str] = None
    extras: dict = field(default_factory=dict)
    wkt: Optional[str] = None  # POLYGON(...)


@dataclass
class ParseResult:
    sites: list[SiteRow] = field(default_factory=list)
    roads: list[RoadRow] = field(default_factory=list)
    lessors: list[LessorRow] = field(default_factory=list)


def _text(el: etree._Element, xpath: str) -> Optional[str]:
    found = el.xpath(xpath, namespaces=NS)
    if not found:
        return None
    val = found[0]
    if isinstance(val, etree._Element):
        val = val.text
    return val.strip() if isinstance(val, str) and val.strip() else None


def _schema_data(pm: etree._Element) -> tuple[Optional[str], dict[str, str]]:
    """返回 (schema_url, simple_data_dict)。schema_url 形如 '#site' / '#road' / '#lessor'。"""
    sd = pm.find(".//k:ExtendedData/k:SchemaData", NS)
    if sd is None:
        return None, {}
    schema_url = sd.get("schemaUrl")
    data: dict[str, str] = {}
    for el in sd.findall("k:SimpleData", NS):
        name = el.get("name")
        if name and el.text is not None:
            data[name] = el.text.strip()
    return schema_url, data


def _point_wkt(pm: etree._Element) -> Optional[str]:
    coords = _text(pm, ".//k:Point/k:coordinates/text()")
    if not coords:
        return None
    parts = coords.split(",")
    if len(parts) < 2:
        return None
    lon, lat = parts[0].strip(), parts[1].strip()
    return f"POINT({lon} {lat})"


def _line_wkt(pm: etree._Element) -> Optional[str]:
    coords = _text(pm, ".//k:LineString/k:coordinates/text()")
    if not coords:
        return None
    pts = []
    for tok in coords.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            pts.append(f"{parts[0].strip()} {parts[1].strip()}")
    if len(pts) < 2:
        return None
    return f"LINESTRING({', '.join(pts)})"


def _polygon_wkt(pm: etree._Element) -> Optional[str]:
    coords = _text(
        pm, ".//k:Polygon/k:outerBoundaryIs/k:LinearRing/k:coordinates/text()"
    )
    if not coords:
        return None
    pts = []
    for tok in coords.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            pts.append(f"{parts[0].strip()} {parts[1].strip()}")
    if len(pts) < 4:
        return None
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    return f"POLYGON(({', '.join(pts)}))"


def _to_float(v: Optional[str]) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def parse_kml(data: bytes) -> ParseResult:
    """解析 KML 字节流。"""
    root = etree.fromstring(data)
    result = ParseResult()

    for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        schema_url, simple = _schema_data(pm)

        kind = None
        if schema_url:
            kind = schema_url.lstrip("#").lower()  # site / road / lessor
        else:
            # 兜底：按几何类型判断
            if pm.find(".//k:Point", NS) is not None:
                kind = "site"
            elif pm.find(".//k:LineString", NS) is not None:
                kind = "road"
            elif pm.find(".//k:Polygon", NS) is not None:
                kind = "lessor"

        if kind == "site":
            wkt = _point_wkt(pm)
            if not wkt:
                continue
            site_id = simple.get("SITE ID", "").strip()
            if not site_id:
                continue
            result.sites.append(
                SiteRow(
                    site_id=site_id,
                    option=simple.get("OPTION", "").strip(),
                    project=simple.get("PROJECT") or None,
                    site_status=simple.get("SITE STATUS") or None,
                    lati=_to_float(simple.get("LATI")),
                    longi=_to_float(simple.get("LONGI")),
                    extras={k: v for k, v in simple.items() if v != ""},
                    wkt=wkt,
                )
            )
        elif kind == "road":
            wkt = _line_wkt(pm)
            if not wkt:
                continue
            result.roads.append(
                RoadRow(
                    property=simple.get("Property") or None,
                    extras={k: v for k, v in simple.items() if v != ""},
                    wkt=wkt,
                )
            )
        elif kind == "lessor":
            wkt = _polygon_wkt(pm)
            if not wkt:
                continue
            fid = simple.get("fid", "").strip()
            if not fid:
                continue
            # 兼容 KML 里把 Category 拼成 Cagegory 的情况
            category = simple.get("Lessor Category") or simple.get("Lessor Cagegory")
            result.lessors.append(
                LessorRow(
                    fid=fid,
                    lessor_name=simple.get("Lessor Name") or None,
                    lessor_category=category,
                    relationship=simple.get("Relationship") or None,
                    extras={k: v for k, v in simple.items() if v != ""},
                    wkt=wkt,
                )
            )

    return result
