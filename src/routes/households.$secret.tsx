import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { ParentShell } from "../components/ParentShell";

export const Route = createFileRoute("/households/$secret")({ component: HouseholdRoute });

function HouseholdRoute() {
  const { secret } = Route.useParams();
  const location = useLocation();
  if (location.pathname.endsWith("/onboarding")) return <Outlet />;
  return <ParentShell secret={secret} />;
}
