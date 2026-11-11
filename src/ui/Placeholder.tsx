export default function Placeholder({ title }: { title: string }) {
  return (
    <section className="placeholder">
      <h2>{title}</h2>
      <p className="muted">Coming soon.</p>
    </section>
  )
}
