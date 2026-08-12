import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DonationLink } from "../components/DonationLink";
import { Ident } from "../components/Ident";
import { InstallationDetails } from "../components/InstallationDetails";
import { parentApi, parentKeys } from "../lib/parent-api";

export const Route = createFileRoute("/households/$secret/onboarding")({ component: OnboardingPage });

function OnboardingPage() {
  const { secret } = Route.useParams();
  const sessionQuery = useQuery({
    queryKey: parentKeys.session(secret),
    queryFn: () => parentApi(`/api/households/${secret}/session`, { notifyOnUnauthorized: false }),
    retry: false,
  });

  return (
    <main id="main" className="mx-auto min-h-screen w-full max-w-5xl px-4 py-10 sm:py-16">
      <header className="mb-8">
        <Ident className="mb-3">Household created</Ident>
        <h1 className="max-w-[20ch] text-[clamp(1.75rem,5vw,2.75rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">Save your details, then install</h1>
        <p className="mt-2 max-w-[68ch] leading-relaxed text-muted-foreground">Your Parent session is ready. You do not need to enter your PIN again.</p>
        <span className="mt-3 inline-block text-sm font-medium text-accent" role="status">
          {sessionQuery.isSuccess ? "Parent session confirmed for one hour." : sessionQuery.isError ? "Your Parent session could not be confirmed. Return to creation and try again." : "Confirming secure Parent session…"}
        </span>
      </header>

      <section className="mb-8 rounded-[4px] border border-warning-border bg-warning-bg p-4 text-warning-text sm:p-5" aria-labelledby="save-heading">
        <h2 id="save-heading" className="text-base font-semibold">Save both private details now</h2>
        <p className="mt-1 text-sm leading-relaxed">Neither your six-digit PIN nor your private Household URL can be recovered. Store the PIN safely and bookmark the Parent Page URL.</p>
      </section>

      <InstallationDetails secret={secret} numbered />
      <DonationLink className="mt-10" />
    </main>
  );
}
