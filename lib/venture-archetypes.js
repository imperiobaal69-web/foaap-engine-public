// =============================================================================
//  Venture archetypes — the DOMAIN layer of FOAAP's core formula:
//  ONTOLOGY (subnode-patterns.js) × DOMAIN (this file) × MAESTRO (the LLM).
//
//  An archetype does NOT duplicate patterns. The library stays the single
//  catalog of structural concepts; an archetype is a lens that tells the
//  system WHICH of those patterns matter, in what order, and what "complete"
//  looks like for a given KIND of venture. A B2B SaaS, a bike-fleet, a
//  creator business and a research spinout share the same ontology but need
//  different spines surfaced first.
//
//  How it's used:
//    - Detection: Maestro infers the archetype and it lands on
//      profile.archetype (primary). detectArchetype() is the heuristic
//      fallback when Maestro stays silent — same dual path as venture_name.
//    - Consumption: the pillar modal biases ghost rows toward the spine,
//      skips deemphasized patterns, and sizes coverage/health against the
//      archetype's spine instead of a flat 5/pillar.
//    - Awareness: buildVentureContext surfaces the archetype to Maestro so he
//      reasons natively ("hardware → ops + fleet + debt; don't push equity").
//
//  Open taxonomy still holds: deemphasized ≠ forbidden. If the founder raises
//  a deemphasized concept it activates normally, and emergent subnodes are
//  unaffected. The archetype only changes the DEFAULT shape.
//
//  Schema per archetype:
//    id            — kebab-case, stable; stored on profile.archetype
//    label         — display name
//    description   — one line
//    signals       — lowercase keyword/phrase safety-net for detectArchetype
//    spine         — pattern ids that form this venture's structural backbone
//                    (biased to surface; sized as the coverage/health target)
//    deemphasize   — pattern ids that are usually noise here (not suggested)
//    pillarFrames  — per-pillar lens for how Maestro tilts the first question
//    emergentHints — concepts this archetype routinely surfaces OUTSIDE the
//                    library, so neither Maestro nor the system is surprised
// =============================================================================

import { getPattern } from "./subnode-patterns.js";

export const ARCHETYPES = [
  {
    id: "b2b-saas",
    label: "B2B SaaS",
    description: "Recurring-revenue software sold to businesses; PLG or sales-led.",
    signals: ["b2b", "saas", "software", "subscription", "per seat", "per-seat", "dashboard", "api", "enterprise", "workflow tool", "for teams", "recurring revenue", "mrr", "arr"],
    spine: ["core-value-proposition", "user-definition", "mvp-definition", "iteration-loop", "pricing-model", "acquisition-channel", "first-100-users", "funding-strategy", "runway-model"],
    deemphasize: ["fleet-or-inventory", "asset-backed-debt", "content-strategy", "grants-non-dilutive"],
    pillarFrames: {
      foundations: "Entity + who's building; software ventures keep this light and move fast.",
      product: "The wedge feature and the one workflow it replaces — smallest shippable slice.",
      "go-to-market": "Motion first: self-serve PLG or sales-led? Then the first 10 logos.",
      capital: "Runway to a metric (ARR / logos) — bootstrapped or venture-track.",
    },
    emergentHints: ["sales-motion", "onboarding-flow", "key-integrations", "churn-model"],
  },
  {
    id: "consumer",
    label: "Consumer App",
    description: "Consumer-facing app or product; growth- and retention-driven.",
    signals: ["consumer app", "mobile app", "ios app", "android app", "d2c", "direct to consumer", "social app", "downloads", "free app", "gamif", "everyday users", "b2c"],
    spine: ["core-value-proposition", "user-definition", "mvp-definition", "validation-strategy", "growth-loops", "acquisition-channel", "community-strategy", "launch-plan", "first-100-users"],
    deemphasize: ["platform-surface", "asset-backed-debt", "grants-non-dilutive"],
    pillarFrames: {
      foundations: "Light entity; the focus is the product and the audience.",
      product: "The hook and the smallest loop that proves people come back.",
      "go-to-market": "Acquisition + the growth loop that compounds; nail the launch moment.",
      capital: "Runway to a retention/growth signal worth raising on.",
    },
    emergentHints: ["retention-hook", "viral-mechanic", "activation-moment"],
  },
  {
    id: "marketplace",
    label: "Marketplace",
    description: "Two-sided platform connecting supply and demand; liquidity-driven.",
    signals: ["marketplace", "two-sided", "two sided", "connect buyers", "supply and demand", "matchmaking", "gig", "platform connecting", "sellers and buyers", "take rate", "commission", "both sides"],
    spine: ["core-value-proposition", "user-definition", "mvp-definition", "first-100-users", "growth-loops", "partnerships-distribution", "pricing-model", "geographic-anchor", "geographic-expansion"],
    deemphasize: ["platform-surface", "grants-non-dilutive", "asset-backed-debt"],
    pillarFrames: {
      foundations: "Where liquidity starts — the first geography or niche.",
      product: "Define BOTH sides and the smallest market that clears.",
      "go-to-market": "Which side do you seed first, and what makes it liquid?",
      capital: "Runway to liquidity in the first market before expanding.",
    },
    emergentHints: ["supply-acquisition", "liquidity", "trust-and-safety", "take-rate-model"],
  },
  {
    id: "hardware-physical",
    label: "Hardware / Physical",
    description: "Owns and operates physical assets — devices, fleet, inventory, food.",
    signals: ["hardware", "device", "fleet", "inventory", "bikes", "bicycles", "manufacturing", "supply chain", "warehouse", "physical product", "units", "logistics", "iot", "wearable", "owned assets"],
    spine: ["geographic-anchor", "operations-spine", "core-value-proposition", "user-definition", "fleet-or-inventory", "pricing-model", "asset-backed-debt", "runway-model"],
    deemphasize: ["platform-surface", "growth-loops", "content-strategy", "equity-round"],
    pillarFrames: {
      foundations: "Where it physically operates + the ops spine that must run reliably.",
      product: "The physical unit + its maintenance cycle, not just the value prop.",
      "go-to-market": "Distribution + partnerships before growth loops.",
      capital: "Capex reality: asset-backed debt and unit economics, not equity-first.",
    },
    emergentHints: ["unit-economics", "maintenance-cycle", "supply-chain", "manufacturing"],
  },
  {
    id: "creator-media",
    label: "Creator / Media",
    description: "Content- and audience-first venture; monetized via subs, sponsorship, products.",
    signals: ["content", "creator", "media", "newsletter", "podcast", "youtube", "audience", "editorial", "publish", "subscribers", "sponsorship", "brand deals", "channel"],
    spine: ["content-strategy", "core-value-proposition", "user-definition", "community-strategy", "acquisition-channel", "pricing-model", "launch-plan"],
    deemphasize: ["platform-surface", "fleet-or-inventory", "equity-round", "asset-backed-debt"],
    pillarFrames: {
      foundations: "Light entity; the asset is the audience and the editorial voice.",
      product: "The editorial spine — cadence, format, the audience's job.",
      "go-to-market": "Distribution cadence + community; the monetization mix.",
      capital: "Usually revenue-first; runway from audience monetization.",
    },
    emergentHints: ["editorial-calendar", "distribution-cadence", "monetization-mix"],
  },
  {
    id: "local-services",
    label: "Local Services",
    description: "Local/SMB service business; bootstrapped, revenue-first, geography-bound.",
    signals: ["local", "service business", "services", "clinic", "salon", "restaurant", "cafe", "shop", "studio", "agency", "consulting", "neighborhood", "in-person", "appointments", "bootstrapped"],
    spine: ["geographic-anchor", "operations-spine", "core-value-proposition", "user-definition", "pricing-model", "first-100-users", "revenue-first", "funding-strategy"],
    deemphasize: ["platform-surface", "equity-round", "growth-loops", "geographic-expansion"],
    pillarFrames: {
      foundations: "The location + the ops that deliver the service reliably.",
      product: "The service and the customer; what makes them come back.",
      "go-to-market": "First local customers + repeat; reputation over loops.",
      capital: "Revenue-first; what funds the first months, not a raise.",
    },
    emergentHints: ["service-delivery", "local-reputation", "repeat-customers"],
  },
  {
    id: "deep-tech-research",
    label: "Deep-Tech / Research",
    description: "IP- and science-heavy venture; grants + equity, long horizon, milestone-gated.",
    signals: ["deep tech", "deep-tech", "research", "spinout", "ip", "patent", "biotech", "hardtech", "r&d", "lab", "scientific", "clinical", "regulatory", "fda", "breakthrough", "thesis"],
    spine: ["core-value-proposition", "validation-strategy", "mvp-definition", "advisor-mentorship", "core-team-composition", "funding-strategy", "grants-non-dilutive", "equity-round", "runway-model"],
    deemphasize: ["growth-loops", "content-strategy", "fleet-or-inventory"],
    pillarFrames: {
      foundations: "The science/IP edge + the team and advisors that de-risk it.",
      product: "The proof, not the polish — what experiment validates the thesis?",
      "go-to-market": "Early design partners over channels; commercialization is later.",
      capital: "Grants + equity to fund milestones; long runway to the next proof.",
    },
    emergentHints: ["ip-strategy", "tech-milestones", "regulatory-path"],
  },
];

// Graceful default — when Maestro hasn't classified yet (or can't), behavior
// is exactly today's: the full library at its native alwaysRelevant, flat
// 5/pillar coverage, no spine bias. Zero regression for unclassified ventures.
export const GENERAL_ARCHETYPE = {
  id: "general",
  label: "General",
  description: "Not yet classified — full library, no archetype bias.",
  signals: [],
  spine: null,
  deemphasize: [],
  pillarFrames: {},
  emergentHints: [],
};

const BY_ID = ARCHETYPES.reduce((acc, a) => { acc[a.id] = a; return acc; }, {});

export function getArchetype(id) {
  return BY_ID[id] || null;
}

// Returns the archetype object, or the GENERAL fallback for null / unknown ids.
export function resolveArchetype(id) {
  return BY_ID[id] || GENERAL_ARCHETYPE;
}

export function archetypeLabel(id) {
  return (BY_ID[id] || GENERAL_ARCHETYPE).label;
}

// Heuristic detector — SAFETY NET only. Maestro is the primary classifier
// (he sets profile.archetype directly). Scores each archetype by how many of
// its signals appear in the text and returns the clear winner. Conservative:
// requires at least 2 signal hits AND a margin over the runner-up, so a
// single ambiguous word doesn't lock in a wrong archetype. Returns id | null.
export function detectArchetype(text) {
  if (!text || typeof text !== "string") return null;
  const lower = text.toLowerCase();
  const scored = ARCHETYPES.map((a) => ({
    id: a.id,
    score: a.signals.reduce((n, kw) => (lower.includes(kw) ? n + 1 : n), 0),
  })).sort((x, y) => y.score - x.score);

  const top = scored[0];
  const runnerUp = scored[1];
  if (!top || top.score < 2) return null;
  if (runnerUp && top.score - runnerUp.score < 1) return null; // tie → stay unsure
  return top.id;
}

// Spine pattern ids that belong to a given pillar, for an archetype. Used to
// size adaptive coverage/health and to drive archetype-aware ghost rows.
// Returns [] for the general archetype (callers fall back to the flat target).
export function spineForPillar(id, pillarSlug) {
  const a = resolveArchetype(id);
  if (!a.spine) return [];
  const pillar = String(pillarSlug || "").toLowerCase();
  return a.spine.filter((pid) => {
    const p = getPattern(pid);
    return p && p.pillar === pillar;
  });
}

export function isDeemphasized(id, patternId) {
  const a = resolveArchetype(id);
  return Array.isArray(a.deemphasize) && a.deemphasize.includes(patternId);
}
