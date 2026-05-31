import { useEffect, useRef } from "react";

/**
 * F19 · 隐藏入口：连续按 N 次 Esc（相邻间隔 < windowMs）触发回调。
 * Spec V1.x #23：N=3, windowMs=1000。
 *
 * 注意：不阻止默认行为 — 用户用 Esc 关闭其他 dialog 仍正常工作。
 * 触发后清空时间戳数组（防抖），避免连续触发。
 */
export function useEscTrigger(
  onTrigger: () => void,
  times = 3,
  windowMs = 1000,
): void {
  const stampsRef = useRef<number[]>([]);
  const cbRef = useRef(onTrigger);
  cbRef.current = onTrigger;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const now = Date.now();
      const arr = stampsRef.current;
      arr.push(now);
      // 仅保留最近 `times` 次
      while (arr.length > times) arr.shift();
      if (arr.length < times) return;
      // 检查相邻间隔都 < windowMs
      let ok = true;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] - arr[i - 1] >= windowMs) {
          ok = false;
          break;
        }
      }
      if (ok) {
        stampsRef.current = [];
        cbRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [times, windowMs]);
}
