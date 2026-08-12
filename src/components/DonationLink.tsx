import { Coffee } from "lucide-react";

const donationUrl = "https://buymeacoffee.com/kieren.foenander";

export function DonationLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={donationUrl}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline ${className}`}
    >
      <Coffee className="size-3.5" aria-hidden="true" />
      Buy me a coffee
    </a>
  );
}
