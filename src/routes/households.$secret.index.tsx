import { createFileRoute } from "@tanstack/react-router";
import { HouseholdOverview } from "../components/HouseholdOverview";

export const Route = createFileRoute("/households/$secret/")({ component: Overview });
function Overview() {
  const { secret } = Route.useParams();
  return <section className="destination" aria-labelledby="page-heading">
    <header className="destination-header">
      <p className="eyebrow">Household</p>
      <h1 id="page-heading">Overview</h1>
      <p>Current Programmes, the immediate TV schedule, and useful next steps.</p>
    </header>
    <HouseholdOverview secret={secret} />
  </section>;
}
