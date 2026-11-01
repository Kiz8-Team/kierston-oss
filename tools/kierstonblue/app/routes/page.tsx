import { RouteWorkspace } from "@/components/routes/RouteWorkspace";

export const metadata = { title: "Routes · KierstonBlue" };

export default function RoutesPage() {
  return (
    <main id="content" className="relative h-full overflow-hidden">
      <RouteWorkspace />
    </main>
  );
}
