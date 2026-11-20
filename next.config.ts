import type { NextConfig } from "next";

// Single-owner instance: the public marketing and SEO pages of the upstream
// project (sponsor links, upstream author, GitHub star fetch) are not needed.
// Everything that is not app, API, tracked link, invite or report goes to the
// login, which itself forwards signed-in users to the dashboard (proxy.ts).
const MARKETING_PATHS = [
  "/",
  "/manychat-alternative",
  "/comment-link-automation",
  "/instagram-comment-to-dm-templates",
  "/instagram-dm-automation-agencies",
  "/meta-review",
  "/templates",
  "/templates/:slug*",
];

// The bundled /privacy, /terms and /data-deletion pages are generic texts that
// name the upstream project as contact. When the operator's own legal pages are
// configured, send visitors (and Meta's crawler) there instead.
const LEGAL_REDIRECTS: Array<[string, string | undefined]> = [
  ["/privacy", process.env.LEGAL_PRIVACY_URL],
  ["/terms", process.env.LEGAL_TERMS_URL],
  ["/data-deletion", process.env.LEGAL_DATA_DELETION_URL],
];

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  async redirects() {
    return [
      ...MARKETING_PATHS.map((source) => ({
        source,
        destination: "/login",
        permanent: false,
      })),
      ...LEGAL_REDIRECTS.filter((entry): entry is [string, string] =>
        Boolean(entry[1])
      ).map(([source, destination]) => ({
        source,
        destination,
        permanent: false,
      })),
    ];
  },
};

export default nextConfig;
