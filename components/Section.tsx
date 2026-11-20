export function Section({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
        {aside && <span className="text-xs tabular-nums text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
