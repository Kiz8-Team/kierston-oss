import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { CameraWorkspace } from "@/components/cameras/CameraWorkspace";

export const metadata = { title: "Plate readers · KierstonBlue" };

export default function CamerasPage() {
  return (
    <main id="content" className="relative h-full overflow-hidden">
      <Suspense fallback={<EmptyState>Loading plate readers…</EmptyState>}>
        <CameraWorkspace />
      </Suspense>
    </main>
  );
}
