import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
    <main id="main" className="page-shell page-shell-wide">
      <header className="hero">
        <p className="eyebrow">Household created</p>
        <h1>Save your details, then install</h1>
        <p>Your Parent session is ready. You do not need to enter your PIN again.</p>
        <span className="session-state" role="status">{sessionQuery.isSuccess ? "Parent session confirmed for one hour." : sessionQuery.isError ? "Your Parent session could not be confirmed. Return to creation and try again." : "Confirming secure Parent session…"}</span>
      </header>

      <section className="warning warning-strong" aria-labelledby="save-heading">
        <h2 id="save-heading">Save both private details now</h2>
        <p>Neither your six-digit PIN nor your private Household URL can be recovered. Store the PIN safely and bookmark the Parent Page URL.</p>
      </section>

      <InstallationDetails secret={secret} numbered />
    </main>
  );
}
