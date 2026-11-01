import { join } from "node:path";
import type { NextConfig } from "next";

// The repository is one Bun workspace: `next` and the shared packages resolve
// from the root, so that is the root Turbopack and file tracing must use.
const WORKSPACE_ROOT = join(__dirname, "..", "..");

const config: NextConfig = {
  // The simulation data lives outside this directory, and every dataset is
  // served through a route handler rather than copied into public/ — a build
  // that duplicated 100 MB of GraphML on every change would be unusable.
  outputFileTracingRoot: WORKSPACE_ROOT,
  turbopack: { root: WORKSPACE_ROOT },
  // Workspace packages ship TypeScript source, so Next has to compile them.
  transpilePackages: ["kierston-records"],
};

export default config;
