import { createFileRoute } from "@tanstack/react-router";
import { DestinationPage } from "../components/DestinationPage";
export const Route = createFileRoute("/households/$secret/movie-channel")({ component: Page });
function Page() { return <DestinationPage eyebrow="Channel" title="Movie Channel" description="Review the Current Programme and movie rotation." />; }
