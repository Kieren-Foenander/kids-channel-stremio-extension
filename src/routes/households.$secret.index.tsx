import { createFileRoute } from "@tanstack/react-router";
import { HouseholdOverview } from "../components/HouseholdOverview";
import { PageHeader } from "../components/PageHeader";

export const Route = createFileRoute("/households/$secret/")({ component: Overview });
function Overview() {
  const { secret } = Route.useParams();
  return (
    <section aria-labelledby="page-heading">
      <PageHeader ident="Household" title="Overview" description="Current Programmes, the immediate TV schedule, and useful next steps." />
      <HouseholdOverview secret={secret} />
    </section>
  );
}
