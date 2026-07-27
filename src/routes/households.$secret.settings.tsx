import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
import { LegacyParentWorkflows } from "../components/LegacyParentWorkflows";
export const Route = createFileRoute("/households/$secret/settings")({ component: Page });
function Page() {
  const { secret } = Route.useParams();
  return <>
    <DestinationPage eyebrow="Parent Page" title="Settings" description="Installation, Parent access, and Household settings." />
    <LegacyParentWorkflows secret={secret} surface="settings" />
  </>;
}
