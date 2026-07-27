import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
export const Route = createFileRoute("/households/$secret/settings")({ component: Page });
function Page() { return <DestinationPage eyebrow="Parent Page" title="Settings" description="Installation, Parent access, and Household settings." />; }
