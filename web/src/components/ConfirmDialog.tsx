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
  title, body, confirmLabel = "确定", cancelLabel = "取消",
  destructive = false, onConfirm, onCancel,
}: Props) {
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
          <button onClick={onCancel}>{cancelLabel}</button>
          <button
            className={destructive ? "danger" : "primary"}
            onClick={onConfirm}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
