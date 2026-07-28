import { Ident } from "./Ident";

export function PageHeader({
  ident,
  title,
  description,
  headingId = "page-heading",
}: {
  ident?: string;
  title: string;
  description: string;
  headingId?: string;
}) {
  return (
    <header className="mb-8">
      {ident ? <Ident className="mb-3">{ident}</Ident> : null}
      <h1
        id={headingId}
        className="max-w-[24ch] text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance"
      >
        {title}
      </h1>
      <p className="mt-2 max-w-[68ch] leading-relaxed text-muted-foreground">{description}</p>
    </header>
  );
}
