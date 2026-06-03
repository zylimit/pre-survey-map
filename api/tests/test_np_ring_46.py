import math
from xml.etree import ElementTree as ET

import pytest

from exporters.kmz import _np_ring_placemark, build_kml, pack_kmz
from parsers.kmz import parse_kmz


NS = {"k": "http://www.opengis.net/kml/2.2"}


def _point(lng: float, lat: float) -> str:
    return f"<Point><coordinates>{lng},{lat}</coordinates></Point>"


def _line() -> str:
    return (
        "<LineString><coordinates>"
        "121.0000,14.5000 121.0100,14.5100"
        "</coordinates></LineString>"
    )


def _polygon() -> str:
    return (
        "<Polygon><outerBoundaryIs><LinearRing><coordinates>"
        "121.0000,14.5000 121.0100,14.5000 121.0100,14.5100 "
        "121.0000,14.5100 121.0000,14.5000"
        "</coordinates></LinearRing></outerBoundaryIs></Polygon>"
    )


def _site_rows() -> list[dict]:
    return [
        {
            "site_id": "S-MACRO",
            "option": "A",
            "project": "P",
            "site_status": "positive",
            "type": "Macro",
            "lati": 14.50,
            "longi": 121.00,
            "extras": {},
            "geom_kml": _point(121.00, 14.50),
        },
        {
            "site_id": "S-MACRO-NP",
            "option": "B",
            "project": "P",
            "site_status": "negative",
            "type": "Macro NP",
            "lati": 14.51,
            "longi": 121.01,
            "extras": {},
            "geom_kml": _point(121.01, 14.51),
        },
        {
            "site_id": "S-MICRO-NP",
            "option": "C",
            "project": "P",
            "site_status": "positive",
            "type": "Micro NP",
            "lati": 14.52,
            "longi": 121.02,
            "extras": {},
            "geom_kml": _point(121.02, 14.52),
        },
    ]


def _road_rows() -> list[dict]:
    return [{"property": "Road 1", "extras": {}, "geom_kml": _line()}]


def _lessor_rows() -> list[dict]:
    return [
        {
            "fid": "L1",
            "lessor_name": "Lessor 1",
            "lessor_category": "Cat",
            "relationship": "Normal",
            "extras": {},
            "geom_kml": _polygon(),
        }
    ]


def _ring_folder(kml: str) -> ET.Element:
    root = ET.fromstring(kml)
    folder = root.find(".//k:Folder[@id='np-radius-rings']", NS)
    assert folder is not None
    return folder


def test_np_ring_round_trip_preserves_entities_and_ignores_rings():
    sites = _site_rows()
    roads = _road_rows()
    lessors = _lessor_rows()

    kmz = pack_kmz(build_kml(sites, roads, lessors, np_radius_m=200))
    result = parse_kmz(kmz)

    assert len(result.sites) == len(sites)
    assert len(result.roads) == len(roads)
    assert len(result.lessors) == len(lessors)
    assert {lessor.fid for lessor in result.lessors} == {"L1"}


@pytest.mark.parametrize(
    ("lati", "longi"),
    [
        (math.nan, 121.0),
        (14.5, math.inf),
        (95.0, 121.0),
        (14.5, 181.0),
        (None, 121.0),
        ("abc", 121.0),
    ],
)
def test_np_ring_placemark_rejects_invalid_coordinates(lati, longi):
    row = {"site_id": "S", "option": "A", "lati": lati, "longi": longi}

    assert _np_ring_placemark(row, 1, 200) is None


def test_np_ring_placemark_valid_coordinates_are_finite():
    row = {"site_id": "S", "option": "A", "lati": 14.5, "longi": 121.0}

    placemark = _np_ring_placemark(row, 1, 200)

    assert placemark is not None
    assert "nan" not in placemark.lower()
    assert "inf" not in placemark.lower()


def test_np_ring_export_structure_radius_and_non_np_filtering():
    kml_200 = build_kml(_site_rows(), [], [], np_radius_m=200)
    ring_folder = _ring_folder(kml_200)
    ring_placemarks = ring_folder.findall("k:Placemark", NS)

    assert len(ring_placemarks) == 2
    assert "ring_of" in kml_200
    assert "ring_radius_m" in kml_200
    assert "<value>200</value>" in kml_200
    assert "S-MACRO|A" not in kml_200

    for placemark in ring_placemarks:
        assert placemark.find(".//k:SchemaData", NS) is None
        assert placemark.find(".//k:Data[@name='ring_of']", NS) is not None
        assert placemark.find(".//k:Data[@name='ring_radius_m']", NS) is not None

    kml_100 = build_kml(_site_rows(), [], [], np_radius_m=100)

    assert "<value>100</value>" in kml_100
    assert "<value>200</value>" not in kml_100
