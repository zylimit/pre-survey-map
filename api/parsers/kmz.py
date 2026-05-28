"""KMZ 解析。KMZ 即 ZIP 包，含一个 doc.kml（或第一个 .kml 文件）。"""

import io
import zipfile

from .kml import ParseResult, parse_kml


def parse_kmz(data: bytes) -> ParseResult:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        kml_name = None
        for name in zf.namelist():
            if name.lower() == "doc.kml":
                kml_name = name
                break
        if kml_name is None:
            for name in zf.namelist():
                if name.lower().endswith(".kml"):
                    kml_name = name
                    break
        if kml_name is None:
            raise ValueError("KMZ 内未找到 .kml 文件")
        return parse_kml(zf.read(kml_name))
