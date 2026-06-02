import { useEffect, useRef } from "react";

/**
 * #42 · 物理键连按 N 次（相邻间隔 < windowMs）触发回调。仿 useEscTrigger。
 * 用 e.code（物理键位，布局无关）。
 *
 * 屏蔽：
 *  - 输入框 / textarea / contentEditable 聚焦时不触发（别和打字冲突）。
 *  - enabled=false（如导入提交中）时不触发，并清空时间栈。
 */
export function useKeyTrigger(
  code: string,            // 物理键位，如 "KeyB"
  onTrigger: () => void,
  times = 3,
  windowMs = 1000,
  enabled = true,
): void {
  const stampsRef = useRef<number[]>([]);
  const cbRef = useRef(onTrigger);
  cbRef.current = onTrigger;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== code) return;
      if (!enabledRef.current) { stampsRef.current = []; return; }
      // 输入态不触发
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) {
        stampsRef.current = [];
        return;
      }
      const now = Date.now();
      const arr = stampsRef.current;
      arr.push(now);
      while (arr.length > times) arr.shift();
      if (arr.length < times) return;
      let ok = true;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] - arr[i - 1] >= windowMs) { ok = false; break; }
      }
      if (ok) {
        stampsRef.current = [];
        cbRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [code, times, windowMs]);
}
