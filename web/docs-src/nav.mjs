/* The documentation tree.
 *
 * This is the single source of truth: the sidebar, the breadcrumb trail, the
 * "related" blocks, the search index and the sitemap entries are all derived
 * from it. Adding a page means adding one entry here and one file in pages/ —
 * nothing else needs to know.
 *
 * Concept pages and task pages are deliberately kept apart. A concept page
 * answers "what is this and what does it guarantee"; a task page answers "how
 * do I do it". Splitting them keeps two pages from competing for one query,
 * which is the mistake that would undo the point of writing them.
 */

export const SITE = "https://hoodlock.tech";

export const SECTIONS = [
  {
    title: "Getting started",
    items: [
      { slug: "quickstart", title: "Quickstart" },
      { slug: "connect-wallet", title: "Connecting a wallet" },
      { slug: "fees", title: "Fees" },
    ],
  },
  {
    title: "Guides",
    items: [
      { slug: "how-to-lock-tokens", title: "Lock tokens" },
      { slug: "how-to-lock-liquidity", title: "Lock LP tokens" },
      { slug: "how-to-create-vesting", title: "Create a vesting schedule" },
      { slug: "how-to-burn-tokens", title: "Burn tokens" },
      { slug: "how-to-extend-a-lock", title: "Extend a lock" },
      { slug: "how-to-verify-a-lock", title: "Verify someone else's lock" },
    ],
  },
  {
    title: "Products",
    items: [
      { slug: "token-locker", title: "Token locker" },
      { slug: "liquidity-locker", title: "Liquidity locker" },
      { slug: "token-vesting", title: "Token vesting" },
      { slug: "token-burning", title: "Token burning" },
      { slug: "airdrops", title: "Airdrops" },
      { slug: "proof-of-lock", title: "Proof of lock" },
      { slug: "lock-explorer", title: "Lock explorer" },
    ],
  },
  {
    title: "Trust and safety",
    items: [
      { slug: "security", title: "Security model" },
      { slug: "when-a-lock-expires", title: "When a lock expires" },
      { slug: "troubleshooting", title: "Troubleshooting" },
    ],
  },
  {
    title: "Reference",
    items: [
      { slug: "contracts", title: "Contracts" },
      { slug: "network", title: "Network" },
      { slug: "api", title: "REST API" },
      { slug: "embed", title: "Embed widget" },
    ],
  },
  {
    title: "Comparisons",
    items: [
      { slug: "vs/stonkbrokers", title: "vs StonkBrokers" },
      { slug: "vs/multi-chain-lockers", title: "vs multi-chain lockers" },
      { slug: "vs/diy-locking", title: "vs locking it yourself" },
    ],
  },
  {
    title: "More",
    items: [
      { slug: "faq", title: "FAQ" },
      { slug: "learn", title: "Learn" },
    ],
  },
];

/** Flat list in sidebar order — used for prev/next and the sitemap. */
export const PAGES = SECTIONS.flatMap((s) =>
  s.items.map((i) => ({ ...i, section: s.title })),
);

export const bySlug = (slug) => PAGES.find((p) => p.slug === slug) || null;

/** Sitemap priority. The hub and the two highest-intent guides rank above the rest. */
export const priorityFor = (slug) => {
  if (slug === "") return "0.9";
  if (["how-to-lock-tokens", "how-to-lock-liquidity", "faq"].includes(slug)) return "0.8";
  if (["token-locker", "liquidity-locker", "token-vesting", "airdrops", "contracts", "security"].includes(slug)) return "0.7";
  return "0.6";
};
