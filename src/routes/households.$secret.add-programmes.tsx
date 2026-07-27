import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
import { LegacyParentWorkflows } from "../components/LegacyParentWorkflows";
export const Route = createFileRoute("/households/$secret/add-programmes")({ component: Page });
function Page() {
  const { secret } = Route.useParams();
  return <>
    <DestinationPage eyebrow="Approved Library" title="Add Programmes" description="Search for shows and movies to approve." />
    <LegacyParentWorkflows secret={secret} surface="search" />
  </>;
}
