import { useT } from "../i18n";

interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title, body, confirmLabel, cancelLabel,
  destructive = false, onConfirm, onCancel,
}: Props) {
  const tFn = useT();
  const okLabel = confirmLabel ?? tFn("dlg.ok");
  const noLabel = cancelLabel ?? tFn("dlg.cancel");

  return (
    <div className="modal-mask">
      <div className="modal confirm-modal">
        <div className="modal-header">
          <h2>{title}</h2>
        </div>
        <div className="modal-body confirm-body">
          {body.split("\n").map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
        <div className="modal-footer">
          <button onClick={onCancel}>{noLabel}</button>
          <button
            className={destructive ? "danger" : "primary"}
            onClick={onConfirm}
          >{okLabel}</button>
        </div>
      </div>
    </div>
  );
}
