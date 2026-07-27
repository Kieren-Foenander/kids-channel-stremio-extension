import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
import { LegacyParentWorkflows } from "../components/LegacyParentWorkflows";
export const Route = createFileRoute("/households/$secret/approved-library")({ component: Page });
function Page() {
  const { secret } = Route.useParams();
  return <>
    <DestinationPage eyebrow="Household" title="Approved Library" description="Manage the shows and movies available to your Channels." />
    <LegacyParentWorkflows secret={secret} />
  </>;
}
