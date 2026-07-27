import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
export const Route = createFileRoute("/households/$secret/approved-library")({ component: Page });
function Page() { return <DestinationPage eyebrow="Household" title="Approved Library" description="Manage the shows and movies available to your Channels." />; }
