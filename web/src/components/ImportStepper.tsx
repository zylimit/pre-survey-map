import { I18nKey, useT } from "../i18n";

interface Props {
  current: "cleaning" | "conflicts";
}

const STEPS: { key: "cleaning" | "conflicts"; labelKey: I18nKey }[] = [
  { key: "cleaning",  labelKey: "is.step1" },
  { key: "conflicts", labelKey: "is.step2" },
];

export default function ImportStepper({ current }: Props) {
  const tFn = useT();
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
            <span className="step-label">{tFn(s.labelKey)}</span>
            {i < STEPS.length - 1 && <span className="step-sep">→</span>}
          </div>
        );
      })}
    </div>
  );
}
