export function DestinationPage({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <section className="destination" aria-labelledby="page-heading">
      <header className="destination-header">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id="page-heading">{title}</h1>
        <p>{description}</p>
      </header>
      <div className="card destination-placeholder">
        <p>This focused destination is ready for Household management.</p>
      </div>
    </section>
  );
}
