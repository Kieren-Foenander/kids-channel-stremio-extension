import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
export const Route = createFileRoute("/households/$secret/add-programmes")({ component: Page });
function Page() { return <DestinationPage eyebrow="Approved Library" title="Add Programmes" description="Search for shows and movies to approve." />; }
