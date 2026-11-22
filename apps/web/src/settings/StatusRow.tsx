/** One "label … value" line of Settings → Server. */
export function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="srv-row">
      <span className="srv-label">{label}</span>
      <span className="srv-value">{value}</span>
    </div>
  );
}
