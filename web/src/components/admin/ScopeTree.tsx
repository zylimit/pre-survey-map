/**
 * #50 Phase 14 · 角色数据权限勾选树（Spec F22「权限模型」节）
 *
 * 层级复刻 LayerTree 骨架（不含 type/status 叶子层）：
 *   SITE → Globe / Smart / Dito → EXISTING / PLANNED / SURVEY / AREA（#51）
 *   Road（平级叶子）/ Lessor（平级叶子）
 *
 * scope_node 取值与后端 api/auth/scopes.py 单一真源对齐：
 *   "site" / "site:Globe" / "site:Globe:SURVEY" / "site:Globe:AREA" / "road" / "lessor"
 *   #51：AREA 挂运营商下（site:<op>:AREA），类别级节点不授予 area；
 *   site / site:<op> 继承语义自动涵盖 AREA（已有角色无需改配置）。
 *
 * 存储优化（子级继承）：勾父不存全部子——保存时压缩（子全勾 → 只存父）；
 * 回显时展开（父在 → 子全勾显示）。三态 checkbox：部分子勾 → 父半选。
 */
import { useEffect, useRef } from "react";
import { I18nKey, useT } from "../../i18n";

const OPERATORS = ["Globe", "Smart", "Dito"] as const;
// 类别节点名用英文（后端 scope_node 取值），label 双语对照 LayerTree 类别文案
const CATEGORIES: { node: string; labelKey: I18nKey }[] = [
  { node: "EXISTING", labelKey: "lt.tree.cat.legacy" },
  { node: "PLANNED", labelKey: "lt.tree.cat.planned" },
  { node: "SURVEY", labelKey: "lt.tree.cat.survey" },
];

/** 后端存的压缩 scopes → 展开成完整勾选集（父在 → 全部后代补勾） */
export function expandScopes(scopes: string[]): Set<string> {
  const out = new Set<string>();
  const addOp = (op: string) => {
    out.add(`site:${op}`);
    for (const c of CATEGORIES) out.add(`site:${op}:${c.node}`);
    out.add(`site:${op}:AREA`);  // #51：op 继承涵盖 AREA
  };
  for (const s of scopes) {
    if (s === "site") {
      out.add("site");
      for (const op of OPERATORS) addOp(op);
    } else if (s === "road" || s === "lessor") {
      out.add(s);
    } else {
      out.add(s);
      // "site:<op>" → 补三个类别子节点 + AREA
      if (s.split(":").length === 2) {
        for (const c of CATEGORIES) out.add(`${s}:${c.node}`);
        out.add(`${s}:AREA`);
      }
    }
  }
  return out;
}

/** 完整勾选集 → 压缩存储（某节点后代全勾 → 只存该节点） */
export function compressScopes(sel: Set<string>): string[] {
  const out: string[] = [];
  // #51：op 全勾 = 三类别 + AREA 都在（AREA 是 op 的第四个子节点）
  const fullOps = OPERATORS.filter(op =>
    CATEGORIES.every(c => sel.has(`site:${op}:${c.node}`)) && sel.has(`site:${op}:AREA`),
  );
  if (fullOps.length === OPERATORS.length) {
    out.push("site");
  } else {
    for (const op of fullOps) out.push(`site:${op}`);
    for (const op of OPERATORS) {
      if (fullOps.includes(op)) continue;
      for (const c of CATEGORIES) {
        if (sel.has(`site:${op}:${c.node}`)) out.push(`site:${op}:${c.node}`);
      }
      if (sel.has(`site:${op}:AREA`)) out.push(`site:${op}:AREA`);
    }
  }
  if (sel.has("road")) out.push("road");
  if (sel.has("lessor")) out.push("lessor");
  return out;
}

/** node 的全部后代叶子（叶子返回自身）。site → 9 类别叶 + 3 AREA 叶；op → 3 类别叶 + AREA 叶 */
function leavesOf(node: string): string[] {
  if (node === "site") {
    return OPERATORS.flatMap(op => [
      ...CATEGORIES.map(c => `site:${op}:${c.node}`),
      `site:${op}:AREA`,
    ]);
  }
  if (node.startsWith("site:") && node.split(":").length === 2) {
    return [...CATEGORIES.map(c => `${node}:${c.node}`), `${node}:AREA`];
  }
  return [node];
}

interface TriBoxProps {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/** 三态 checkbox：indeterminate 只能经 ref 设置（非 HTML 属性） */
function TriBox({ checked, indeterminate, disabled, onToggle }: TriBoxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
    />
  );
}

interface Props {
  value: string[];                        // 压缩后的 scope_node 数组
  onChange: (scopes: string[]) => void;   // 回传压缩后的数组
  disabled?: boolean;                     // is_admin 角色只读展示
}

export default function ScopeTree({ value, onChange, disabled }: Props) {
  const tFn = useT();
  // 受控组件：内部不存 state，勾选集由 value 展开派生
  const sel = expandScopes(value);

  const toggle = (node: string) => {
    if (disabled) return;
    const leaves = leavesOf(node);
    const allOn = leaves.every(l => sel.has(l));
    const next = new Set(sel);
    if (allOn) {
      for (const l of leaves) next.delete(l);
    } else {
      for (const l of leaves) next.add(l);
    }
    onChange(compressScopes(next));
  };

  const stateOf = (node: string): { checked: boolean; indeterminate: boolean } => {
    const leaves = leavesOf(node);
    const on = leaves.filter(l => sel.has(l)).length;
    return { checked: on === leaves.length, indeterminate: on > 0 && on < leaves.length };
  };

  const renderNode = (node: string, label: string, depth: number, hint?: string) => {
    const st = stateOf(node);
    return (
      <div className="scope-node" style={{ paddingLeft: depth * 18 }}>
        <TriBox
          checked={st.checked}
          indeterminate={st.indeterminate}
          disabled={disabled}
          onToggle={() => toggle(node)}
        />
        <span>{label}</span>
        {hint && <span className="scope-node-en">{hint}</span>}
      </div>
    );
  };

  return (
    <div className="scope-tree">
      {renderNode("site", tFn("lt.tree.site"), 0, "SITE")}
      {OPERATORS.map(op => (
        <div key={op}>
          {renderNode(`site:${op}`, op, 1)}
          {CATEGORIES.map(c => (
            <div key={c.node}>
              {renderNode(`site:${op}:${c.node}`, tFn(c.labelKey), 2, c.node)}
            </div>
          ))}
          {/* #51：AREA 权限节点（与类别并列，site:<op>:AREA） */}
          {renderNode(`site:${op}:AREA`, tFn("lt.tree.area"), 2, "AREA")}
        </div>
      ))}
      {renderNode("road", tFn("lt.tree.road"), 0, "ROAD")}
      {renderNode("lessor", tFn("lt.tree.lessor"), 0, "LESSOR")}
    </div>
  );
}
