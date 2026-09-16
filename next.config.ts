import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  images: {
    // Next 16 refuses to optimize images that resolve to private IPs, which
    // blocks the local docker WordPress at localhost:8080.
    dangerouslyAllowLocalIP: process.env.NODE_ENV === "development",
    remotePatterns: [
      {
        protocol: "https",
        hostname: "woo.meowspaces.xyz",
      },
      {
        protocol: "https",
        hostname: "cdn.discordapp.com",
      },
      {
        protocol: "http",
        hostname: "localhost",
        port: "8080",
      },
    ],
  },
};

export default withNextIntl(nextConfig);
