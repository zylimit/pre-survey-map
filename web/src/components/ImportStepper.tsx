interface Props {
  current: "cleaning" | "conflicts";
}

const STEPS: { key: "cleaning" | "conflicts"; label: string }[] = [
  { key: "cleaning", label: "1. 数据清洗" },
  { key: "conflicts", label: "2. 冲突检测" },
];

export default function ImportStepper({ current }: Props) {
  const currentIdx = STEPS.findIndex(s => s.key === current);
  return (
    <div className="stepper">
      {STEPS.map((s, i) => {
        const state =
          i < currentIdx ? "done" :
          i === currentIdx ? "active" : "pending";
        return (
          <div key={s.key} className={`step step-${state}`}>
            <span className="step-marker">
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className="step-label">{s.label}</span>
            {i < STEPS.length - 1 && <span className="step-sep">→</span>}
          </div>
        );
      })}
    </div>
  );
}
