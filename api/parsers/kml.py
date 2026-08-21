"""KML parser. 把 KML 字节流解成 site / road / lessor / area 四类列表。

数据约定：每个 Placemark 用 ExtendedData/SchemaData[@schemaUrl] 标识类型；
缺 schemaUrl 的 Placemark 按几何类型兜底（Point→site / LineString→road / Polygon→lessor）。
#51：schemaUrl="#area"（本平台导出）或无 schema 的外来面要素（如 NCR_BCA，
ExtendedData 走 <Data name> 而非 SchemaData）额外产出 area 候选——area 归属由
导入入口 target_kind 决定，不靠源 schema；解析层只负责候选产出。
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
class AreaRow:
    name: str
    extras: dict = field(default_factory=dict)
    wkt: Optional[str] = None  # POLYGON(...)


@dataclass
class ParseResult:
    sites: list[SiteRow] = field(default_factory=list)
    roads: list[RoadRow] = field(default_factory=list)
    lessors: list[LessorRow] = field(default_factory=list)
    areas: list[AreaRow] = field(default_factory=list)


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
    # .// 匹配天然解 MultiGeometry 壳（Polygon 嵌在 MultiGeometry 里也命中）。
    # #51 review MEDIUM-1：MultiGeometry 含多个 Polygon 时取**外环鞋带面积最大者**
    # （原取第一个，首面未必是主面）。鞋带公式在经纬度平面上做相对比较足够准——
    # 同一 Placemark 内多面相邻，投影畸变同向，不影响大小排序。
    rings = pm.xpath(
        ".//k:Polygon/k:outerBoundaryIs/k:LinearRing/k:coordinates", namespaces=NS
    )
    best_pts: Optional[list[str]] = None
    best_area = -1.0
    for el in rings:
        coords = (el.text or "").strip()
        if not coords:
            continue
        pts: list[str] = []
        xy: list[tuple[float, float]] = []
        for tok in coords.split():
            parts = tok.split(",")
            if len(parts) >= 2:
                pts.append(f"{parts[0].strip()} {parts[1].strip()}")
                try:
                    xy.append((float(parts[0]), float(parts[1])))
                except ValueError:
                    xy.append((0.0, 0.0))  # 面积计算用兜底值；WKT 保留原始字符串
        if len(pts) < 4:
            continue
        if pts[0] != pts[-1]:
            pts.append(pts[0])
            xy.append(xy[0])
        # 鞋带公式（平面近似，仅用于同 Placemark 内多面比大小）
        area = abs(
            sum(
                xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1]
                for i in range(len(xy) - 1)
            )
        ) / 2
        if area > best_area:
            best_area = area
            best_pts = pts
    if best_pts is None:
        return None
    return f"POLYGON(({', '.join(best_pts)}))"


def _to_float(v: Optional[str]) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


# F20 (V1.x #24/#25)：operator/category/type 三列由图层导入盖戳写入，源文件同名属性
# （含 type 的源别名 SITE TYPE）一律并入白名单排除，防属性面板「同字段重复显示」
_SITE_CORE = {
    "SITE ID", "OPTION", "PROJECT", "SITE STATUS", "LATI", "LONGI",
    "OPERATOR", "CATEGORY", "TYPE", "SITE TYPE",
}
_ROAD_CORE = {"Property"}
_LESSOR_CORE = {"fid", "Lessor Name", "Lessor Category", "Lessor Cagegory", "Relationship"}
# #51：area 保留字段（去重键 name + 盖戳列 operator 不进 extras；源大小写写法都排除）
_AREA_CORE = {"name", "Name", "operator", "OPERATOR"}


def _data_fields(pm: etree._Element) -> dict[str, str]:
    """ExtendedData 下 <Data name="..."><value>v</value></Data> → dict。

    无 SchemaData 的外来文件（如 NCR_BCA.kmz）走这条；空 value 跳过（同 extras 过滤口径）。
    """
    out: dict[str, str] = {}
    for el in pm.findall(".//k:ExtendedData/k:Data", NS):
        name = el.get("name")
        if not name:
            continue
        val = el.find("k:value", NS)
        text = val.text if val is not None else None
        if isinstance(text, str) and text.strip():
            out[name] = text.strip()
    return out


def _area_row(name: str, fields: dict[str, str], pm: etree._Element) -> Optional[AreaRow]:
    """构造 area 候选行。name 为空（去重键缺失）或无面几何 → None（跳过）。"""
    name = (name or "").strip()
    if not name:
        return None
    wkt = _polygon_wkt(pm)
    if not wkt:
        return None
    return AreaRow(
        name=name,
        extras={k: v for k, v in fields.items() if v != "" and k not in _AREA_CORE},
        wkt=wkt,
    )


_RING_FOLDER_IDS = {"np-radius-rings"}
_RING_FOLDER_NAMES = {"np-radius-rings", "NP 范围圈"}


def _is_np_ring(pm: etree._Element) -> bool:
    """#46：判断 Placemark 是否为 NP 范围圈（只出不进，导入整体忽略）。

    以 ExtendedData 的 ring_of 标记为主（最稳）；祖先 Folder id/name 为辅。
    Data 和 SimpleData 两种写法都认。
    """
    # 主：ring_of 标记（<Data name="ring_of"> 或 <SimpleData name="ring_of">）
    for el in pm.findall(".//k:ExtendedData/k:Data", NS):
        if el.get("name") == "ring_of":
            return True
    for el in pm.findall(".//k:ExtendedData//k:SimpleData", NS):
        if el.get("name") == "ring_of":
            return True
    # 辅：祖先 Folder id/name 命中
    node = pm.getparent()
    while node is not None:
        if etree.QName(node).localname == "Folder":
            if (node.get("id") or "") in _RING_FOLDER_IDS:
                return True
            name = node.find("k:name", NS)
            if name is not None and (name.text or "").strip() in _RING_FOLDER_NAMES:
                return True
        node = node.getparent()
    return False


def parse_kml(data: bytes) -> ParseResult:
    """解析 KML 字节流。"""
    root = etree.fromstring(data)
    result = ParseResult()

    for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        # #46：NP 范围圈整体跳过——必须早于「schema 缺失 Polygon→lessor」兜底，
        # 否则圈会被当 lessor 灌库，破坏自反一致性契约。
        if _is_np_ring(pm):
            continue

        schema_url, simple = _schema_data(pm)

        kind = None
        if schema_url:
            kind = schema_url.lstrip("#").lower()  # site / road / lessor / area
        else:
            # 兜底：按几何类型判断
            if pm.find(".//k:Point", NS) is not None:
                kind = "site"
            elif pm.find(".//k:LineString", NS) is not None:
                kind = "road"
            elif pm.find(".//k:Polygon", NS) is not None:
                kind = "lessor"
                # #51：无 schema 的外来面要素（如 NCR_BCA）同时产出 area 候选——
                # <Data name="Name"> → name，其余 Data 进 extras。lessor 分支
                # 仍需 fid（来自 SchemaData），无 schema 文件不会产生 lessor 行，
                # 两份产出无重叠；归属由导入入口 target_kind 决定。
                data = _data_fields(pm)
                area = _area_row(data.get("Name"), data, pm)
                if area is not None:
                    result.areas.append(area)

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
                    extras={k: v for k, v in simple.items() if v != "" and k not in _SITE_CORE},
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
                    extras={k: v for k, v in simple.items() if v != "" and k not in _ROAD_CORE},
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
                    extras={k: v for k, v in simple.items() if v != "" and k not in _LESSOR_CORE},
                    wkt=wkt,
                )
            )
        elif kind == "area":
            # #51：本平台导出的 area（schemaUrl="#area"）走 SimpleData——
            # 自反契约：重导入 name 精确回环，100% 命中冲突
            area = _area_row(simple.get("name") or simple.get("Name"), simple, pm)
            if area is not None:
                result.areas.append(area)

    return result
