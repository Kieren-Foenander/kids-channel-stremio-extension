import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";

export const Route = createFileRoute("/households/$secret/")({ component: Overview });
function Overview() { return <DestinationPage eyebrow="Household" title="Overview" description="A concise view of your Household and both Channels." />; }
