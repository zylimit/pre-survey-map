import { memo, useEffect, useMemo, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import XYZ from "ol/source/XYZ";
import GeoJSONFormat from "ol/format/GeoJSON";
import { Style, Fill, Stroke, Circle as CircleStyle, RegularShape, Text as TextStyle } from "ol/style";
import { fromLonLat, toLonLat } from "ol/proj";
import { defaults as defaultControls, ScaleLine, MousePosition } from "ol/control";
import { createStringXY } from "ol/coordinate";
import { createEmpty, extend, isEmpty } from "ol/extent";
import Draw, { createBox } from "ol/interaction/Draw";
import type { DrawEvent } from "ol/interaction/Draw";
import type { FeatureLike } from "ol/Feature";
import OlFeature from "ol/Feature";
import { Polygon, MultiPolygon, Point, Circle as CircleGeom } from "ol/geom";
import { fromCircle } from "ol/geom/Polygon";

import { Feature, FeatureCollection, GeoJSONPolygon } from "../api";
import { DrawMode } from "../state";
import { useT } from "../i18n";
import {
  siteStatusColor, siteShape, lessorLineColor, areaColor,
  metersToProjRadius, withAlpha, STATUS_COLOR, LAYER_COLOR, OPERATOR_LETTER,
  type ShapeKind,
} from "../utils";
import { filterByScope, type ScopeCtx } from "../scopes";

type BasemapKey = "positron" | "osm" | "esri" | "google";

// 从 :root 上 theme.css 定义的变量读色。OL 的 style 函数不能直接吃 var()，必须读出字符串。
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface Props {
  sites: FeatureCollection;
  roads: FeatureCollection;
  lessors: FeatureCollection;
  areas: FeatureCollection;   // #51：AREA 面图层（运营商分色，渲染在点/线层之下）
  selectedId: string | number | null;
  flyTarget: { feature: Feature; epoch: number } | null;
  drawMode: DrawMode;
  selectionPolygon: GeoJSONPolygon | null;
  hiddenIds: Set<string>;
  fitAllEpoch: number;
  layoutEpoch: number;
  npRadiusM: number;            // #45：NP 辐射圈半径（米，全局统一），变化时强制 NP 圈重绘
  showPolygonLabels: boolean;   // #52 F24 ④：area/lessor 面名称标签全局显隐
  onDropDisabled: () => void;   // #28：地图拖拽导入已禁用，拖入只提示不导入
  onSelectFeature: (f: Feature | null) => void;
  onSelectionDrawn: (polygon: GeoJSONPolygon, mode: DrawMode) => void;
  onFitAll: () => void;
  // #50 Phase 15：数据权限双保险（数据已被后端过滤，前端渲染前再按 scope 过滤一次）
  scopes: string[];
  isAdmin: boolean;
}

// 仅「UI chrome 色」从 theme.css 读（选中高亮 / 选区框）。
// ⚠️ 要素「数据语义色」（site_status / relationship / road）不在这里——它们硬编码在
//    utils.ts 的 STATUS_COLOR，不参与主题切换（#19 地图区护栏）。
const COLOR = {
  siteStroke: "",       // site 实心图标的描边（白边，UI chrome）
  selected: "",         // 选中高亮描边
  selectionStroke: "",  // 框选边
  selectionFill: "",    // 框选填充
};

function initColors() {
  COLOR.siteStroke = cssVar("--feat-site-stroke");
  COLOR.selected = cssVar("--feat-selected-stroke");
  COLOR.selectionStroke = cssVar("--selection-stroke");
  COLOR.selectionFill = cssVar("--selection-fill");
}

// #52 修复：高密度下字母/标签糊屏——只在放大到街区级才显示。
// resolution 越小越放大。EPSG:3857 web mercator，赤道 zoom每+1 resolution减半。
// zoom 6 (看全菲律宾) resolution≈2445；zoom 13 (城区) ≈19；zoom 15 (街区) ≈4.8。
// 阈值取 zoom≈13 对应 resolution，站点字母放大到城区级才显；面标签同理略宽松。
const LETTER_MAX_RESOLUTION = 20;    // 站点运营商字母：resolution < 20（约 zoom≥13）才显
const POLY_LABEL_MAX_RESOLUTION = 300;  // 面名称标签：resolution < 300（约 zoom≥9）才显（面比点少，可早点显）

// RegularShape 形状参数：三角/正方/菱形（圆走 CircleStyle）。
// radiusFactor 补偿不同形状的视觉面积差，让各图标看着差不多大。
const SHAPE_CFG: Record<Exclude<ShapeKind, "circle">, { points: number; angle: number; radiusFactor: number }> = {
  triangle: { points: 3, angle: 0,            radiusFactor: 1.3 },   // 顶点朝上三角
  square:   { points: 4, angle: Math.PI / 4,  radiusFactor: 1.1 },   // 正方（旋转 45° 平边朝上）
  diamond:  { points: 4, angle: 0,            radiusFactor: 1.25 },  // 菱形（顶点朝上）
};

// F20 Phase 5：site 要素 = 形状(type) × 颜色(site_status)
// 实心=存量 / 空心=规划 / 菱形=勘测；颜色按状态；type 缺失退化为默认圆点。
// 规划类（Macro NP / Micro NP）额外叠一个透明辐射圈（半径可配 #45，仅渲染不入库）。
function siteStyle(feature: FeatureLike, selected: boolean, npRadiusM: number, resolution: number): Style[] {
  const status = feature.get("site_status") as string | undefined;
  const type = feature.get("type") as string | undefined;
  const category = feature.get("category") as string | undefined;
  const spec = siteShape(type);

  // #44：颜色按 category 分叉——状态分色只在勘测；存量橙 / 规划紫（形状仍 siteShape(type)）
  const color = category === "存量" ? LAYER_COLOR["存量"]
    : category === "规划" ? LAYER_COLOR["规划"]
    : siteStatusColor(status);   // 勘测 + 兜底 → 状态色

  const radius = selected ? 9 : 6;
  // #44 fill：规划用半透明 55% 填充（原空心→半透色块，卫星上显眼仍透底）；
  //          存量/勘测保持原 filled 规则（实心 fill / 空心无 fill）。
  const fill = category === "规划"
    ? new Fill({ color: withAlpha(LAYER_COLOR["规划"], 0.55) })
    : spec.filled ? new Fill({ color }) : undefined;
  // stroke：选中盖蓝；规划紫描边不透明；其余 实心白边 / 空心状态色
  const strokeColor = selected ? COLOR.selected
    : category === "规划" ? LAYER_COLOR["规划"]
    : spec.filled ? COLOR.siteStroke
    : color;
  const strokeWidth = selected ? 3 : (spec.filled ? 1.5 : 2);
  const stroke = new Stroke({ color: strokeColor, width: strokeWidth });

  const image = spec.shape === "circle"
    ? new CircleStyle({ radius, fill, stroke })
    : new RegularShape({
        points: SHAPE_CFG[spec.shape].points,
        radius: radius * SHAPE_CFG[spec.shape].radiusFactor,
        angle: SHAPE_CFG[spec.shape].angle,
        fill,
        stroke,
      });

  const styles: Style[] = [new Style({ image })];

  // 辐射圈：用 geometry 函数把点替换成真实 npRadiusM 半径的 Circle（地图单位，缩放自适应）
  if (spec.ring) {
    styles.push(new Style({
      geometry: (feat) => {
        const g = (feat as OlFeature).getGeometry();
        if (!g || g.getType() !== "Point") return undefined;
        const coord = (g as Point).getCoordinates();
        const lat = toLonLat(coord)[1];
        return new CircleGeom(coord, metersToProjRadius(npRadiusM, lat));
      },
      stroke: new Stroke({ color, width: 1, lineDash: [4, 3] }),
      fill: new Fill({ color: withAlpha(color, 0.08) }),
    }));
  }

  // #52 F24 ①：运营商首字母叠在点中心（白字+深描边，各底色可读；空 operator 不叠）
  const op = feature.get("operator") as string | undefined;
  const letter = op ? OPERATOR_LETTER[op] : undefined;
  if (letter && resolution < LETTER_MAX_RESOLUTION) {   // 只在放大到街区级才叠字母
    styles.push(new Style({
      text: new TextStyle({
        text: letter,
        font: `700 ${selected ? 13 : 11}px sans-serif`,
        fill: new Fill({ color: "#fff" }),
        stroke: new Stroke({ color: "#0b0f14", width: 3 }),
        textAlign: "center",
        textBaseline: "middle",
      }),
    }));
  }
  return styles;
}

function roadStyle(_f: FeatureLike, selected: boolean): Style {
  return new Style({
    stroke: new Stroke({
      color: selected ? COLOR.selected : STATUS_COLOR.road,
      width: selected ? 5 : 3,
    }),
  });
}

// #52 F24 ④：面名称标签——文本叠在面的可视中心（interior point，比几何中心更稳，
// 凹多边形也落在面内）。白字深描边保证各底色可读；declutter 层负责碰撞避让。
// Polygon 用 getInteriorPoint()，MultiPolygon 用 getInteriorPoints() 取首点。
function polygonLabelStyle(text: string): Style {
  return new Style({
    text: new TextStyle({
      text,
      font: "600 12px sans-serif",
      fill: new Fill({ color: "#fff" }),
      stroke: new Stroke({ color: "#0b0f14", width: 3 }),
      textAlign: "center",
      textBaseline: "middle",
      overflow: true,
    }),
    geometry: (feat) => {
      const g = (feat as OlFeature).getGeometry();
      if (!g) return undefined;
      const type = g.getType();
      if (type === "Polygon") return (g as Polygon).getInteriorPoint();
      if (type === "MultiPolygon") {
        const pts = (g as MultiPolygon).getInteriorPoints();
        const coords = pts.getCoordinates();
        return coords.length ? new Point(coords[0]) : undefined;
      }
      return g;
    },
  });
}

// Lessor 面：去 Friendly，只剩 Unfriendly 红 / Normal 黄（线色来自单一真源，面 = 线色 30% 透明）
function lessorStyle(feature: FeatureLike, selected: boolean, showLabel: boolean, resolution: number): Style[] {
  const rel = feature.get("relationship") as string | undefined;
  const line = lessorLineColor(rel);
  const styles: Style[] = [new Style({
    stroke: new Stroke({ color: selected ? COLOR.selected : line, width: selected ? 4 : 2 }),
    fill: new Fill({ color: withAlpha(line, 0.30) }),
  })];
  const name = feature.get("lessor_name") as string | undefined;
  if (showLabel && name && resolution < POLY_LABEL_MAX_RESOLUTION) styles.push(polygonLabelStyle(name));
  return styles;
}

// #51 F23：AREA 面——按运营商分色（AREA_COLOR 单一真源），~35% 透明填充 + 同色 1px 描边；
// 选中盖高亮蓝加粗（与 lessor 同处理——Globe 蓝与选中蓝同值，靠描边宽度区分）
function areaStyle(feature: FeatureLike, selected: boolean, showLabel: boolean, resolution: number): Style[] {
  const op = feature.get("operator") as string | undefined;
  const color = areaColor(op);
  const styles: Style[] = [new Style({
    stroke: new Stroke({ color: selected ? COLOR.selected : color, width: selected ? 3 : 1 }),
    fill: new Fill({ color: withAlpha(color, 0.35) }),
  })];
  const name = feature.get("name") as string | undefined;
  if (showLabel && name && resolution < POLY_LABEL_MAX_RESOLUTION) styles.push(polygonLabelStyle(name));
  return styles;
}

function MapView({
  sites, roads, lessors, areas, selectedId, flyTarget,
  drawMode, selectionPolygon, hiddenIds, fitAllEpoch, layoutEpoch, npRadiusM, showPolygonLabels,
  onDropDisabled, onSelectFeature, onSelectionDrawn, onFitAll,
  scopes, isAdmin,
}: Props) {
  const tFn = useT();
  // #50 Phase 15：前端双保险——渲染前按 scope 过滤（site 按 operator/category，road/lessor 按类型）
  const scopeCtx: ScopeCtx = useMemo(() => ({ isAdmin, scopes }), [isAdmin, scopes]);
  const visSites = useMemo(() => filterByScope(scopeCtx, "site", sites), [scopeCtx, sites]);
  const visRoads = useMemo(() => filterByScope(scopeCtx, "road", roads), [scopeCtx, roads]);
  const visLessors = useMemo(() => filterByScope(scopeCtx, "lessor", lessors), [scopeCtx, lessors]);
  // #51：area 按 feature operator 逐个判定（site:<op>:AREA 只授予单运营商）
  const visAreas = useMemo(() => filterByScope(scopeCtx, "area", areas), [scopeCtx, areas]);
  const basemapLabel: Record<BasemapKey, string> = {
    positron: "Positron",
    osm: "OSM",
    esri: tFn("map.basemap.esri"),
    google: tFn("map.basemap.google"),
  };

  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const sitesSrc = useRef(new VectorSource());
  const roadsSrc = useRef(new VectorSource());
  const lessorsSrc = useRef(new VectorSource());
  const areasSrc = useRef(new VectorSource());
  const selectionSrc = useRef(new VectorSource());
  const selectedIdRef = useRef<string | number | null>(null);
  const hiddenIdsRef = useRef<Set<string>>(new Set());
  // #45：站点样式闭包在 init effect 里只建一次，靠 ref 读运行时半径（避免闭包锁旧值）
  const npRadiusRef = useRef<number>(npRadiusM);
  // #52 F24 ④：面标签显隐同理靠 ref 读运行时值（样式闭包只建一次）
  const showLabelsRef = useRef<boolean>(showPolygonLabels);
  const sitesLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const roadsLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const lessorsLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const areasLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const basemapsRef = useRef<{ positron: TileLayer<XYZ>; osm: TileLayer<XYZ>; esri: TileLayer<XYZ>; google: TileLayer<XYZ> } | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKey>("positron");

  // 初始化地图
  useEffect(() => {
    if (!ref.current || mapRef.current) return;

    // 读 CSS 变量到 COLOR 缓存
    initColors();

    // #51：AREA 面层最先挂 → 渲染在点/线层之下（OL 按 layers 数组序绘制），不遮挡站点
    const areasLayer = new VectorLayer({
      source: areasSrc.current,
      declutter: true,   // #52 F24 ④：面名称标签碰撞避让
      style: (f, resolution) => {
        if (hiddenIdsRef.current.has(String(f.getId()))) return undefined;
        return areaStyle(f, f.getId() === selectedIdRef.current, showLabelsRef.current, resolution);
      },
    });
    const lessorsLayer = new VectorLayer({
      source: lessorsSrc.current,
      declutter: true,   // #52 F24 ④：面名称标签碰撞避让
      style: (f, resolution) => {
        if (hiddenIdsRef.current.has(String(f.getId()))) return undefined;
        return lessorStyle(f, f.getId() === selectedIdRef.current, showLabelsRef.current, resolution);
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
      style: (f, resolution) => {
        if (hiddenIdsRef.current.has(String(f.getId()))) return undefined;
        return siteStyle(f, f.getId() === selectedIdRef.current, npRadiusRef.current, resolution);
      },
    });
    sitesLayerRef.current = sitesLayer;
    roadsLayerRef.current = roadsLayer;
    lessorsLayerRef.current = lessorsLayer;
    areasLayerRef.current = areasLayer;

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
        maxZoom: 19,
        attributions: "© Esri",
      }),
    });
    const googleLayer = new TileLayer({
      visible: false,
      source: new XYZ({
        url: "https://mt{0-3}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
        crossOrigin: "anonymous",
        maxZoom: 20,
        attributions: "© Google",
      }),
    });
    basemapsRef.current = { positron: positronLayer, osm: osmLayer, esri: esriLayer, google: googleLayer };

    mapRef.current = new Map({
      target: ref.current,
      layers: [
        positronLayer, osmLayer, esriLayer, googleLayer,
        areasLayer, lessorsLayer, roadsLayer, sitesLayer,
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

  // 数据变更 → 加载到 sources + fit bounds（#50：加载的是 scope 过滤后的子集）
  useEffect(() => {
    loadInto(sitesSrc.current, visSites);
    loadInto(roadsSrc.current, visRoads);
    loadInto(lessorsSrc.current, visLessors);
    loadInto(areasSrc.current, visAreas);

    if (!mapRef.current) return;
    const merged = safeMergedExtent([sitesSrc.current, roadsSrc.current, lessorsSrc.current, areasSrc.current]);
    if (!isEmpty(merged)) {
      mapRef.current.getView().fit(merged, {
        padding: [40, 40, 40, 40],
        maxZoom: 15,
        duration: 400,
      });
    }
  }, [visSites, visRoads, visLessors, visAreas]);

  // 选中状态变化 → 重画当前样式
  useEffect(() => {
    selectedIdRef.current = selectedId;
    sitesLayerRef.current?.changed();
    roadsLayerRef.current?.changed();
    lessorsLayerRef.current?.changed();
    areasLayerRef.current?.changed();
  }, [selectedId]);

  // 隐藏 ids 变化 → 重画（让 style 函数重新判定）
  useEffect(() => {
    hiddenIdsRef.current = hiddenIds;
    sitesLayerRef.current?.changed();
    roadsLayerRef.current?.changed();
    lessorsLayerRef.current?.changed();
    areasLayerRef.current?.changed();
  }, [hiddenIds]);

  // #45 NP 半径变化 → 更新 ref + 强制 site 图层 restyle（geometry 函数重算圈半径）
  // 闭包读旧常量、OL 不会自动重绘，必须显式 .changed()。只动 site 层，其余不受影响。
  useEffect(() => {
    npRadiusRef.current = npRadiusM;
    sitesLayerRef.current?.changed();
  }, [npRadiusM]);

  // #52 F24 ④：面标签显隐变化 → 更新 ref + 强制 area/lessor 两层 restyle
  useEffect(() => {
    showLabelsRef.current = showPolygonLabels;
    areasLayerRef.current?.changed();
    lessorsLayerRef.current?.changed();
  }, [showPolygonLabels]);

  // 底图切换
  useEffect(() => {
    const bm = basemapsRef.current;
    if (!bm) return;
    bm.positron.setVisible(basemap === "positron");
    bm.osm.setVisible(basemap === "osm");
    bm.esri.setVisible(basemap === "esri");
    bm.google.setVisible(basemap === "google");
  }, [basemap]);

  // 面板拖拽中通知 OL 重算视口尺寸，否则地图渲染会错位
  useEffect(() => {
    if (layoutEpoch === 0 || !mapRef.current) return;
    mapRef.current.updateSize();
  }, [layoutEpoch]);

  // 定位按钮：fit bounds 到全部数据
  useEffect(() => {
    if (fitAllEpoch === 0 || !mapRef.current) return;
    const merged = safeMergedExtent([sitesSrc.current, roadsSrc.current, lessorsSrc.current, areasSrc.current]);
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

    // #47：圆形与矩形都用 OL Draw 的 "Circle" type；矩形靠 createBox geometryFunction 出矩形，
    // 圆形不设 geometryFunction（默认交互 = 点圆心拖半径），画出真 Circle 几何。
    const draw = new Draw({
      source: selectionSrc.current,
      type: drawMode === "rectangle" || drawMode === "circle" ? "Circle" : "Polygon",
      geometryFunction: drawMode === "rectangle" ? createBox() : undefined,
      freehand: false,
    });
    draw.on("drawend", (e: DrawEvent) => {
      const geom = e.feature.getGeometry();
      if (!geom) return;
      // #47：圆形几何是 ol/geom Circle，需先在投影坐标(3857)上 fromCircle 转 64 段近似圆多边形；
      // 矩形/多边形本身已是 Polygon。转 4326 前完成多边形化，统一走 GeoJSONPolygon 输出。
      const polyGeom = geom instanceof CircleGeom ? fromCircle(geom, 64) : (geom as Polygon);
      const geo = polyGeom.clone().transform("EPSG:3857", "EPSG:4326") as Polygon;
      const coordinates = geo.getCoordinates();
      onSelectionDrawn({ type: "Polygon", coordinates }, drawMode);
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
      lessorsSrc.current.getFeatureById(id) ||
      areasSrc.current.getFeatureById(id);
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
    // #28：地图拖拽导入已禁用（堵开盖戳旁路）。拖入只提示，不导入。
    const hasFiles = Array.from(e.dataTransfer.types ?? []).includes("Files");
    if (hasFiles) onDropDisabled();
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
          {(["positron", "osm", "esri", "google"] as const).map(k => (
            <button
              key={k}
              className={`map-ctrl-btn ${basemap === k ? "active" : ""}`}
              onClick={() => setBasemap(k)}
              title={basemapLabel[k]}
            >
              {basemapLabel[k]}
            </button>
          ))}
        </div>
      </div>

      {dragOver && <div className="drop-overlay">📥 {tFn("map.drop.hint")}</div>}
      {drawMode && (
        <div className="draw-hint">
          🖱 {tFn(
            drawMode === "polygon"
              ? "tb.draw.hint.poly"
              : drawMode === "circle"
                ? "tb.draw.hint.circle"
                : "tb.draw.hint.rect",
          )}
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
