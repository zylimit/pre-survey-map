import { memo, useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import XYZ from "ol/source/XYZ";
import GeoJSONFormat from "ol/format/GeoJSON";
import { Style, Fill, Stroke, Circle as CircleStyle } from "ol/style";
import { fromLonLat } from "ol/proj";
import { defaults as defaultControls, ScaleLine, MousePosition } from "ol/control";
import { createStringXY } from "ol/coordinate";
import { createEmpty, extend, isEmpty } from "ol/extent";
import Draw, { createBox } from "ol/interaction/Draw";
import type { DrawEvent } from "ol/interaction/Draw";
import type { FeatureLike } from "ol/Feature";
import OlFeature from "ol/Feature";
import { Polygon } from "ol/geom";

import { Feature, FeatureCollection, GeoJSONPolygon } from "../api";
import { DrawMode } from "../state";

type BasemapKey = "positron" | "osm" | "esri";

const BASEMAP_LABEL: Record<BasemapKey, string> = {
  positron: "Positron",
  osm: "OSM",
  esri: "Esri 卫星",
};

// 从 :root 上 theme.css 定义的变量读色。OL 的 style 函数不能直接吃 var()，必须读出字符串。
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface Props {
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  selectedId: string | number | null;
  flyTarget: { feature: Feature; epoch: number } | null;
  drawMode: DrawMode;
  selectionPolygon: GeoJSONPolygon | null;
  hiddenIds: Set<string>;
  fitAllEpoch: number;
  layoutEpoch: number;
  onDropFiles: (files: File[]) => void;
  onSelectFeature: (f: Feature | null) => void;
  onSelectionDrawn: (polygon: GeoJSONPolygon) => void;
  onFitAll: () => void;
}

// 所有要素色从 theme.css 读出来缓存。组件 mount 时 initColors() 填充。
// 这里不放任何硬编码兜底 —— theme.css 是唯一允许定色的地方。
const COLOR = {
  sitePositive: "",
  siteNegative: "",
  siteUnknown: "",
  siteStroke: "",
  lessorFriendly: "",
  lessorFriendlyFill: "",
  lessorNormal: "",
  lessorNormalFill: "",
  lessorUnfriendly: "",
  lessorUnfriendlyFill: "",
  road: "",
  selected: "",
  selectionStroke: "",
  selectionFill: "",
};

function initColors() {
  COLOR.sitePositive = cssVar("--feat-site-positive");
  COLOR.siteNegative = cssVar("--feat-site-negative");
  COLOR.siteUnknown = cssVar("--feat-site-unknown");
  COLOR.siteStroke = cssVar("--feat-site-stroke");
  COLOR.lessorFriendly = cssVar("--feat-lessor-friendly");
  COLOR.lessorFriendlyFill = cssVar("--feat-lessor-friendly-fill");
  COLOR.lessorNormal = cssVar("--feat-lessor-normal");
  COLOR.lessorNormalFill = cssVar("--feat-lessor-normal-fill");
  COLOR.lessorUnfriendly = cssVar("--feat-lessor-unfriendly");
  COLOR.lessorUnfriendlyFill = cssVar("--feat-lessor-unfriendly-fill");
  COLOR.road = cssVar("--feat-road");
  COLOR.selected = cssVar("--feat-selected-stroke");
  COLOR.selectionStroke = cssVar("--selection-stroke");
  COLOR.selectionFill = cssVar("--selection-fill");
}

function sitePinColor(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "positive") return COLOR.sitePositive;
  if (s === "negative") return COLOR.siteNegative;
  return COLOR.siteUnknown;
}

function lessorColors(rel: string | null | undefined): { line: string; fill: string } {
  const r = (rel ?? "").toLowerCase();
  if (r === "friendly") return { line: COLOR.lessorFriendly, fill: COLOR.lessorFriendlyFill };
  if (r === "normal") return { line: COLOR.lessorNormal, fill: COLOR.lessorNormalFill };
  return { line: COLOR.lessorUnfriendly, fill: COLOR.lessorUnfriendlyFill };
}

function siteStyle(feature: FeatureLike, selected: boolean): Style {
  const status = feature.get("site_status") as string | undefined;
  return new Style({
    image: new CircleStyle({
      radius: selected ? 9 : 6,
      fill: new Fill({ color: sitePinColor(status) }),
      stroke: new Stroke({
        color: selected ? COLOR.selected : COLOR.siteStroke,
        width: selected ? 3 : 1.5,
      }),
    }),
  });
}

function roadStyle(_f: FeatureLike, selected: boolean): Style {
  return new Style({
    stroke: new Stroke({
      color: selected ? COLOR.selected : COLOR.road,
      width: selected ? 5 : 3,
    }),
  });
}

function lessorStyle(feature: FeatureLike, selected: boolean): Style {
  const rel = feature.get("relationship") as string | undefined;
  const c = lessorColors(rel);
  return new Style({
    stroke: new Stroke({ color: selected ? COLOR.selected : c.line, width: selected ? 4 : 2 }),
    fill: new Fill({ color: c.fill }),
  });
}

function MapView({
  sites, roads, lessors, selectedId, flyTarget,
  drawMode, selectionPolygon, hiddenIds, fitAllEpoch, layoutEpoch,
  onDropFiles, onSelectFeature, onSelectionDrawn, onFitAll,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const sitesSrc = useRef(new VectorSource());
  const roadsSrc = useRef(new VectorSource());
  const lessorsSrc = useRef(new VectorSource());
  const selectionSrc = useRef(new VectorSource());
  const selectedIdRef = useRef<string | number | null>(null);
  const hiddenIdsRef = useRef<Set<string>>(new Set());
  const sitesLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const roadsLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const lessorsLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const basemapsRef = useRef<{ positron: TileLayer<XYZ>; osm: TileLayer<XYZ>; esri: TileLayer<XYZ> } | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKey>("positron");

  // 初始化地图
  useEffect(() => {
    if (!ref.current || mapRef.current) return;

    // 读 CSS 变量到 COLOR 缓存
    initColors();

    const lessorsLayer = new VectorLayer({
      source: lessorsSrc.current,
      style: (f) => {
        if (hiddenIdsRef.current.has(String(f.getId()))) return undefined;
        return lessorStyle(f, f.getId() === selectedIdRef.current);
      },
    });
    const roadsLayer = new VectorLayer({
      source: roadsSrc.current,
      style: (f) => {
        if (hiddenIdsRef.current.has(String(f.getId()))) return undefined;
        return roadStyle(f, f.getId() === selectedIdRef.current);
      },
    });
    const sitesLayer = new VectorLayer({
      source: sitesSrc.current,
      style: (f) => {
        if (hiddenIdsRef.current.has(String(f.getId()))) return undefined;
        return siteStyle(f, f.getId() === selectedIdRef.current);
      },
    });
    sitesLayerRef.current = sitesLayer;
    roadsLayerRef.current = roadsLayer;
    lessorsLayerRef.current = lessorsLayer;

    const selectionLayer = new VectorLayer({
      source: selectionSrc.current,
      style: new Style({
        stroke: new Stroke({ color: COLOR.selectionStroke, width: 2, lineDash: [6, 4] }),
        fill: new Fill({ color: COLOR.selectionFill }),
      }),
    });

    // 三个底图同时挂上，靠 visible 切换。默认 CartoDB Positron（Spec V1.x Mint Tech）
    const positronLayer = new TileLayer({
      visible: true,
      source: new XYZ({
        url: "https://{a-d}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        crossOrigin: "anonymous",
        maxZoom: 19,
        attributions: "© OpenStreetMap · © CARTO",
      }),
    });
    const osmLayer = new TileLayer({
      visible: false,
      source: new XYZ({
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        crossOrigin: "anonymous",
        maxZoom: 19,
        attributions: "© OpenStreetMap contributors",
      }),
    });
    const esriLayer = new TileLayer({
      visible: false,
      source: new XYZ({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        crossOrigin: "anonymous",
        attributions: "© Esri",
      }),
    });
    basemapsRef.current = { positron: positronLayer, osm: osmLayer, esri: esriLayer };

    mapRef.current = new Map({
      target: ref.current,
      layers: [
        positronLayer, osmLayer, esriLayer,
        lessorsLayer, roadsLayer, sitesLayer,
        selectionLayer,
      ],
      view: new View({ center: fromLonLat([121.0, 14.6]), zoom: 6 }),
      controls: defaultControls().extend([
        new ScaleLine(),
        new MousePosition({
          coordinateFormat: createStringXY(5),
          projection: "EPSG:4326",
          className: "ol-mouse-position",
        }),
      ]),
    });

    mapRef.current.on("singleclick", evt => {
      // 框选模式下不处理选中（让 Draw 接管点击）
      if (drawRef.current) return;
      const hit = mapRef.current!.forEachFeatureAtPixel(evt.pixel, f => f, {
        hitTolerance: 4,
        layerFilter: (l) => l.getSource() !== selectionSrc.current,
      });
      if (!hit) {
        onSelectFeature(null);
        return;
      }
      const props = hit.getProperties() as Record<string, unknown>;
      onSelectFeature({
        type: "Feature",
        id: hit.getId() as string | undefined,
        geometry: null, // 属性面板用不到 geometry
        properties: stripGeom(props),
      });
    });

    return () => {
      mapRef.current?.setTarget(undefined);
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据变更 → 加载到 sources + fit bounds
  useEffect(() => {
    loadInto(sitesSrc.current, sites);
    loadInto(roadsSrc.current, roads);
    loadInto(lessorsSrc.current, lessors);

    if (!mapRef.current) return;
    const merged = safeMergedExtent([sitesSrc.current, roadsSrc.current, lessorsSrc.current]);
    if (!isEmpty(merged)) {
      mapRef.current.getView().fit(merged, {
        padding: [40, 40, 40, 40],
        maxZoom: 15,
        duration: 400,
      });
    }
  }, [sites, roads, lessors]);

  // 选中状态变化 → 重画当前样式
  useEffect(() => {
    selectedIdRef.current = selectedId;
    sitesLayerRef.current?.changed();
    roadsLayerRef.current?.changed();
    lessorsLayerRef.current?.changed();
  }, [selectedId]);

  // 隐藏 ids 变化 → 重画（让 style 函数重新判定）
  useEffect(() => {
    hiddenIdsRef.current = hiddenIds;
    sitesLayerRef.current?.changed();
    roadsLayerRef.current?.changed();
    lessorsLayerRef.current?.changed();
  }, [hiddenIds]);

  // 底图切换
  useEffect(() => {
    const bm = basemapsRef.current;
    if (!bm) return;
    bm.positron.setVisible(basemap === "positron");
    bm.osm.setVisible(basemap === "osm");
    bm.esri.setVisible(basemap === "esri");
  }, [basemap]);

  // 面板拖拽中通知 OL 重算视口尺寸，否则地图渲染会错位
  useEffect(() => {
    if (layoutEpoch === 0 || !mapRef.current) return;
    mapRef.current.updateSize();
  }, [layoutEpoch]);

  // 定位按钮：fit bounds 到全部数据
  useEffect(() => {
    if (fitAllEpoch === 0 || !mapRef.current) return;
    const merged = safeMergedExtent([sitesSrc.current, roadsSrc.current, lessorsSrc.current]);
    if (!isEmpty(merged)) {
      mapRef.current.getView().fit(merged, {
        padding: [40, 40, 40, 40],
        maxZoom: 15,
        duration: 400,
      });
    }
  }, [fitAllEpoch]);

  // drawMode 变化 → 安装 / 卸载 Draw 交互
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    if (drawRef.current) {
      map.removeInteraction(drawRef.current);
      drawRef.current = null;
    }
    if (!drawMode) return;

    selectionSrc.current.clear();

    const draw = new Draw({
      source: selectionSrc.current,
      type: drawMode === "rectangle" ? "Circle" : "Polygon",
      geometryFunction: drawMode === "rectangle" ? createBox() : undefined,
      freehand: false,
    });
    draw.on("drawend", (e: DrawEvent) => {
      const feat = e.feature as OlFeature<Polygon>;
      const geom = feat.getGeometry();
      if (!geom) return;
      // 转回 4326 经纬度坐标
      const geo = geom.clone().transform("EPSG:3857", "EPSG:4326") as Polygon;
      const coordinates = geo.getCoordinates();
      onSelectionDrawn({ type: "Polygon", coordinates });
    });
    map.addInteraction(draw);
    drawRef.current = draw;

    return () => {
      map.removeInteraction(draw);
      if (drawRef.current === draw) drawRef.current = null;
    };
  }, [drawMode, onSelectionDrawn]);

  // 父组件清除 selection 时把 layer 清空（重新绘制时上面 effect 也会 clear）
  useEffect(() => {
    if (selectionPolygon === null && !drawMode) {
      selectionSrc.current.clear();
    }
  }, [selectionPolygon, drawMode]);

  // flyTarget 变化 → 飞到要素
  useEffect(() => {
    if (!flyTarget || !mapRef.current) return;
    const id = flyTarget.feature.id;
    if (id == null) return;
    const feat =
      sitesSrc.current.getFeatureById(id) ||
      roadsSrc.current.getFeatureById(id) ||
      lessorsSrc.current.getFeatureById(id);
    if (!feat) return;
    const geom = feat.getGeometry();
    if (!geom) return;
    const view = mapRef.current.getView();
    const ext = geom.getExtent();

    // 防护：脏数据（坐标超 EPSG:3857 范围、LATI/LONGI 写反）transform 后产生 Infinity；
    // 把 Infinity 喂给 view.animate 会永久损坏 view 状态导致底图消失。
    if (!ext || !ext.every(v => Number.isFinite(v))) {
      view.cancelAnimations();
      return;
    }

    // 双击节点时上一段动画还没跑完就开下一段 → cancel 防止冲突
    view.cancelAnimations();

    if (geom.getType() === "Point") {
      view.animate({
        center: [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2],
        zoom: 17,
        duration: 600,
      });
    } else {
      view.fit(ext, { padding: [80, 80, 80, 80], maxZoom: 18, duration: 600 });
    }
  }, [flyTarget]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) onDropFiles(files);  // 多文件 warn 在 state.importFiles 统一处理（Spec F1）
  };

  return (
    <div
      className={`map ${drawMode ? "drawing" : ""}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div ref={ref} className="ol-map" />

      {/* 右上角自定义控件：定位 + 底图切换 */}
      <div className="map-ctrls">
        <button
          className="map-ctrl-btn"
          title="定位（fit 全部数据）"
          onClick={() => onFitAll()}
        >🎯</button>
        <div className="basemap-switch">
          {(["positron", "osm", "esri"] as const).map(k => (
            <button
              key={k}
              className={`map-ctrl-btn ${basemap === k ? "active" : ""}`}
              onClick={() => setBasemap(k)}
              title={`切换到 ${BASEMAP_LABEL[k]}`}
            >
              {BASEMAP_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {dragOver && <div className="drop-overlay">📥 释放鼠标导入文件</div>}
      {drawMode && (
        <div className="draw-hint">
          {drawMode === "polygon" ? "🖱 点击设顶点 · 双击结束" : "🖱 按住拖动绘制矩形"}
        </div>
      )}
    </div>
  );
}

function stripGeom(props: Record<string, unknown>): Record<string, unknown> {
  const { geometry, ...rest } = props;
  return rest;
}

// 逐 feature 累计 extent，跳过 Infinity/NaN（脏数据 transform 失败产生）。
// 避免一颗脏数据让整个 source.getExtent() 失效。
function safeMergedExtent(sources: VectorSource[]) {
  const merged = createEmpty();
  for (const s of sources) {
    s.forEachFeature(f => {
      const ext = f.getGeometry()?.getExtent();
      if (ext && ext.every(v => Number.isFinite(v))) {
        extend(merged, ext);
      }
    });
  }
  return merged;
}

function loadInto(src: VectorSource, fc: FeatureCollection) {
  src.clear();
  if (!fc.features.length) return;
  const format = new GeoJSONFormat();
  const features = format.readFeatures(fc, {
    dataProjection: "EPSG:4326",
    featureProjection: "EPSG:3857",
  });
  src.addFeatures(features);
}

export default memo(MapView);
