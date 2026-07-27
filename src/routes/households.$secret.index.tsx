import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
import { LegacyParentWorkflows } from "../components/LegacyParentWorkflows";

export const Route = createFileRoute("/households/$secret/")({ component: Overview });
function Overview() {
  const { secret } = Route.useParams();
  return <>
    <DestinationPage eyebrow="Household" title="Overview" description="A concise view of your Household and both Channels." />
    <LegacyParentWorkflows secret={secret} />
  </>;
}
