/** One dashboard figure: a label, a big value and an optional hint line. */
export function Tile({
  label,
  value,
  hint,
  className = "",
  testId,
}: {
  label: string;
  value: string;
  hint?: React.ReactNode;
  className?: string;
  testId: string;
}) {
  return (
    <div className={`rounded-box bg-base-100 p-4 shadow-sm ${className}`} data-testid={testId}>
      <dt className="text-sm text-base-content/70">{label}</dt>
      <dd className="text-4xl font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="mt-1 text-sm text-base-content/70">{hint}</dd>}
    </div>
  );
}
