import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 and sharp are native modules; keep them out of the bundler.
  serverExternalPackages: ["better-sqlite3", "sharp"],
  transpilePackages: ["three"],
};

export default nextConfig;
