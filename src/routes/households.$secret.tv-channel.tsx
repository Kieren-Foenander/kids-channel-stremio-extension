import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
export const Route = createFileRoute("/households/$secret/tv-channel")({ component: Page });
function Page() { return <DestinationPage eyebrow="Channel" title="TV Channel" description="Review the Current Programme and Channel Schedule." />; }
