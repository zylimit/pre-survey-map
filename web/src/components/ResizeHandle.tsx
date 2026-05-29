import { useRef } from "react";

interface Props {
  axis: "x" | "y";
  // 拖拽方向：edge="end" 表示拖拽条挂在面板的「末端」(右/下)，delta 直加；
  // edge="start" 表示挂在「起端」(左/上)，delta 反向（鼠标右移 → 面板变窄）
  edge: "start" | "end";
  min: number;
  max: number;
  onResize: (nextSize: number) => void;
  onResizeEnd?: () => void;
}

// 4px 拖拽条；按下时记录起始 size，move 算 delta + clamp，up 时回调持久化
export default function ResizeHandle({ axis, edge, min, max, onResize, onResizeEnd }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const handle = ref.current;
    const panel = handle?.parentElement;
    if (!panel) return;

    const start = axis === "x" ? e.clientX : e.clientY;
    const startSize = axis === "x" ? panel.offsetWidth : panel.offsetHeight;
    const cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";

    const onMove = (mv: PointerEvent) => {
      const cur = axis === "x" ? mv.clientX : mv.clientY;
      let delta = cur - start;
      if (edge === "start") delta = -delta;
      const next = Math.max(min, Math.min(max, startSize + delta));
      onResize(next);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEnd?.();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={ref}
      className={`resize-handle resize-handle-${axis} resize-handle-${edge}`}
      onPointerDown={onPointerDown}
    />
  );
}
