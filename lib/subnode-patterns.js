// =============================================================================
//  Subnode pattern library — the canonical list of structural patterns
//  Maestro reasons about during intake.
//
//  This list MUST stay in sync with the `<internal_ontology>` section of
//  src/lib/maestro/system-prompts/v1.md. The prompt is the LLM-facing source
//  of truth; this file is the runtime-facing mirror used by the activator
//  dispatcher, the BranchView renderer, and the studios picker.
//
//  Schema per pattern:
//    id                 — kebab-case, stable forever (used as subnode id)
//    pillar             — one of: foundations | product | go-to-market | capital
//    label              — display name in Title Case
//    description        — one-line summary shown under the title in BranchView
//    icon               — Lucide icon name
//    alwaysRelevant     — true if this pattern is universally applicable;
//                         false if conditional (e.g. Equity Round)
//    prerequisites      — pattern ids that must already be activated for
//                         this one to make sense (Maestro should hold
//                         activation if prerequisites are unmet)
//    activationKeywords — heuristic match strings (lowercase) — used as a
//                         safety-net by future activator passes; the
//                         primary activation path is Maestro's tool call
//    firstQuestion      — natural opener to deepen the subnode
// =============================================================================

export const PATTERNS = [
  // ── Foundations ────────────────────────────────────────────────────────────
  {
    id: "legal-entity-structure",
    pillar: "foundations",
    label: "Legal Entity Structure",
    description: "The company shape — LLC, C-corp, sole proprietorship, etc.",
    icon: "Building",
    alwaysRelevant: true,
    prerequisites: [],
    activationKeywords: ["incorporate", "llc", "c-corp", "delaware", "estonia", "entity", "legal shape"],
    firstQuestion: "What jurisdiction and entity shape — and why that one for this venture?",
  },
  {
    id: "founder-composition",
    pillar: "foundations",
    label: "Founder Composition",
    description: "Solo, co-founders, or team — and the rationale.",
    icon: "Users",
    alwaysRelevant: true,
    prerequisites: [],
    activationKeywords: ["solo", "co-founder", "co-founders", "founders", "founding team", "by myself", "with a partner"],
    firstQuestion: "Solo, co-founders, or operator team — and which legal shape supports that?",
  },
  {
    id: "advisor-mentorship",
    pillar: "foundations",
    label: "Advisor or Mentorship",
    description: "Who advises the venture — formal advisors or informal mentors.",
    icon: "UserCheck",
    alwaysRelevant: false,
    prerequisites: ["founder-composition"],
    activationKeywords: ["advisor", "advisors", "mentor", "mentorship", "board"],
    firstQuestion: "Who advises this venture — and what gap do they fill?",
  },
  {
    id: "operations-spine",
    pillar: "foundations",
    label: "Operations Spine",
    description: "Operational backbone — relevant when venture is physical or operationally complex.",
    icon: "Cog",
    alwaysRelevant: false,
    prerequisites: [],
    activationKeywords: ["operations", "logistics", "supply chain", "warehouse", "delivery", "manufacturing"],
    firstQuestion: "What's the operational spine — what has to run reliably for this to work?",
  },
  {
    id: "geographic-anchor",
    pillar: "foundations",
    label: "Geographic Anchor",
    description: "Primary market or operational base.",
    icon: "MapPin",
    alwaysRelevant: true,
    prerequisites: [],
    activationKeywords: ["porto", "lisbon", "berlin", "city", "country", "market", "based in", "operating in"],
    firstQuestion: "Where does this venture live — first market and operational base?",
  },
  {
    id: "core-team-composition",
    pillar: "foundations",
    label: "Core Team Composition",
    description: "Team beyond the founder(s) — relevant only when team is needed.",
    icon: "UsersRound",
    alwaysRelevant: false,
    prerequisites: ["founder-composition"],
    activationKeywords: ["hire", "hiring", "first hire", "team member", "engineer", "designer", "ops lead"],
    firstQuestion: "Who's the first hire — and what does their first 90 days unlock?",
  },

  // ── Product ────────────────────────────────────────────────────────────────
  {
    id: "core-value-proposition",
    pillar: "product",
    label: "Core Value Proposition",
    description: "What you sell, why someone wants it.",
    icon: "Target",
    alwaysRelevant: true,
    prerequisites: [],
    activationKeywords: ["product", "service", "app", "platform", "build", "what i'm building", "value"],
    firstQuestion: "What's the one-line value proposition, and what's the strongest evidence it lands?",
  },
  {
    id: "user-definition",
    pillar: "product",
    label: "User Definition",
    description: "Who the user is and what specific job they're hiring this for.",
    icon: "User",
    alwaysRelevant: true,
    prerequisites: [],
    activationKeywords: ["user", "users", "customer", "audience", "icp", "for people who", "who buys"],
    firstQuestion: "Who's the user, and what specific job replaces what they do today?",
  },
  {
    id: "mvp-definition",
    pillar: "product",
    label: "MVP Definition",
    description: "The smallest version that proves the value proposition.",
    icon: "Box",
    alwaysRelevant: true,
    prerequisites: ["core-value-proposition", "user-definition"],
    activationKeywords: ["mvp", "minimum viable", "prototype", "first version", "v0", "v1"],
    firstQuestion: "What's the smallest thing that proves the value proposition with one real user?",
  },
  {
    id: "iteration-loop",
    pillar: "product",
    label: "Iteration Loop",
    description: "How the product learns from users.",
    icon: "RefreshCcw",
    alwaysRelevant: false,
    prerequisites: ["mvp-definition"],
    activationKeywords: ["iterate", "iteration", "feedback", "learn", "ship cycle", "release cadence"],
    firstQuestion: "How does feedback move from user to product change — what's the loop?",
  },
  {
    id: "validation-strategy",
    pillar: "product",
    label: "Validation Strategy",
    description: "What evidence proves the product is working.",
    icon: "CheckSquare",
    alwaysRelevant: false,
    prerequisites: ["mvp-definition", "user-definition"],
    activationKeywords: ["validate", "validation", "test", "prove", "evidence", "users test", "beta"],
    firstQuestion: "What's the strongest signal that says \"this is working, keep going\"?",
  },
  {
    id: "fleet-or-inventory",
    pillar: "product",
    label: "Fleet or Inventory Management",
    description: "Physical assets the venture owns and operates.",
    icon: "Package",
    alwaysRelevant: false,
    prerequisites: [],
    activationKeywords: ["fleet", "inventory", "stock", "units", "bikes", "cars", "warehouse", "owned"],
    firstQuestion: "How big is the fleet at launch, and what does maintenance cycle look like?",
  },
  {
    id: "content-strategy",
    pillar: "product",
    label: "Content Strategy",
    description: "Editorial output — for media-driven ventures.",
    icon: "FileText",
    alwaysRelevant: false,
    prerequisites: ["user-definition"],
    activationKeywords: ["content", "editorial", "podcast", "newsletter", "video", "publish", "creator"],
    firstQuestion: "What's the editorial spine — cadence, format, voice?",
  },
  {
    id: "platform-surface",
    pillar: "product",
    label: "Platform Surface",
    description: "API or developer platform shape.",
    icon: "Layers",
    alwaysRelevant: false,
    prerequisites: ["mvp-definition"],
    activationKeywords: ["api", "platform", "developer", "infrastructure", "sdk", "integration"],
    firstQuestion: "What's the developer surface — what does an integration look like end-to-end?",
  },

  // ── Go-to-Market ───────────────────────────────────────────────────────────
  {
    id: "first-100-users",
    pillar: "go-to-market",
    label: "First 100 Users",
    description: "Where the first 100 customers come from.",
    icon: "UserPlus",
    alwaysRelevant: true,
    prerequisites: ["user-definition", "mvp-definition"],
    activationKeywords: ["first users", "early users", "first 100", "early adopters", "initial users"],
    firstQuestion: "Where do the first 100 users come from, and what brings them in?",
  },
  {
    id: "acquisition-channel",
    pillar: "go-to-market",
    label: "Acquisition Channel",
    description: "Primary channel that brings users in.",
    icon: "Megaphone",
    alwaysRelevant: true,
    prerequisites: ["first-100-users"],
    activationKeywords: ["acquisition", "channel", "marketing", "ads", "seo", "content", "viral", "word of mouth"],
    firstQuestion: "What's the primary channel — and why that one?",
  },
  {
    id: "pricing-model",
    pillar: "go-to-market",
    label: "Pricing Model",
    description: "How the venture charges.",
    icon: "DollarSign",
    alwaysRelevant: true,
    prerequisites: ["core-value-proposition", "mvp-definition"],
    activationKeywords: ["price", "pricing", "subscription", "monthly", "freemium", "tier", "$", "€"],
    firstQuestion: "What's the pricing shape, and what's the comparable the user already pays for?",
  },
  {
    id: "geographic-expansion",
    pillar: "go-to-market",
    label: "Geographic Expansion",
    description: "Plan for moving beyond the first market.",
    icon: "Globe",
    alwaysRelevant: false,
    prerequisites: ["geographic-anchor"],
    activationKeywords: ["expand", "expansion", "next market", "second city", "international", "scale to"],
    firstQuestion: "After the first market proves out, where next — and what's the trigger?",
  },
  {
    id: "community-strategy",
    pillar: "go-to-market",
    label: "Community Strategy",
    description: "How the venture builds and uses community.",
    icon: "MessagesSquare",
    alwaysRelevant: false,
    prerequisites: ["user-definition"],
    activationKeywords: ["community", "discord", "forum", "members", "tribe", "user group"],
    firstQuestion: "What's the role of community — distribution, retention, product?",
  },
  {
    id: "partnerships-distribution",
    pillar: "go-to-market",
    label: "Partnerships and Distribution",
    description: "Channel partners and distribution deals.",
    icon: "Handshake",
    alwaysRelevant: false,
    prerequisites: ["mvp-definition"],
    activationKeywords: ["partner", "partnership", "distribution", "reseller", "integration partner"],
    firstQuestion: "Who are the obvious distribution partners, and what does the deal shape look like?",
  },
  {
    id: "launch-plan",
    pillar: "go-to-market",
    label: "Launch Plan",
    description: "The coordinated launch moment — narrative, timing, day-one playbook.",
    icon: "Rocket",
    alwaysRelevant: false,
    prerequisites: ["core-value-proposition", "mvp-definition", "first-100-users"],
    activationKeywords: ["launch", "launch day", "go live", "product hunt", "press", "announcement", "unveil", "drop", "release date"],
    firstQuestion: "What's the launch moment — the narrative, the channel, and what day-one success looks like?",
  },
  {
    id: "growth-loops",
    pillar: "go-to-market",
    label: "Growth Loops",
    description: "The compounding engine — retention hooks, referral mechanics, viral loops.",
    icon: "Repeat",
    alwaysRelevant: false,
    prerequisites: ["first-100-users"],
    activationKeywords: ["retention", "referral", "viral", "loop", "flywheel", "network effect", "invite", "word of mouth", "churn", "stickiness"],
    firstQuestion: "What's the loop that makes each user bring or keep the next one — referral, retention, or network effect?",
  },

  // ── Capital ────────────────────────────────────────────────────────────────
  {
    id: "funding-strategy",
    pillar: "capital",
    label: "Funding Strategy",
    description: "Top-level approach to capital.",
    icon: "Wallet",
    alwaysRelevant: true,
    prerequisites: [],
    activationKeywords: ["funding", "capital", "money", "raise", "fund", "finance"],
    firstQuestion: "Bootstrapped, asset-backed debt, or equity round — and what does month 12 look like?",
  },
  {
    id: "runway-model",
    pillar: "capital",
    label: "Runway Model",
    description: "How long the venture's money lasts.",
    icon: "Clock",
    alwaysRelevant: true,
    prerequisites: ["funding-strategy"],
    activationKeywords: ["runway", "burn", "months of money", "until", "savings", "cash"],
    firstQuestion: "How many months of runway — and what milestone does that runway have to hit?",
  },
  {
    id: "equity-round",
    pillar: "capital",
    label: "Equity Round",
    description: "Round shape — relevant only if pursuing equity.",
    icon: "TrendingUp",
    alwaysRelevant: false,
    prerequisites: ["funding-strategy", "founder-composition"],
    activationKeywords: ["seed", "pre-seed", "series a", "investors", "vc", "angels", "raise equity"],
    firstQuestion: "Round size, lead investor profile, and the milestone the round buys?",
  },
  {
    id: "asset-backed-debt",
    pillar: "capital",
    label: "Asset-Backed Debt",
    description: "Debt against physical assets — for capital-intensive ventures.",
    icon: "Landmark",
    alwaysRelevant: false,
    prerequisites: ["funding-strategy"],
    activationKeywords: ["debt", "loan", "asset-backed", "credit line", "leasing", "financing"],
    firstQuestion: "What asset secures the debt, and what's the unit economics that services it?",
  },
  {
    id: "revenue-first",
    pillar: "capital",
    label: "Revenue First",
    description: "Bootstrap path — revenue funds growth.",
    icon: "Coins",
    alwaysRelevant: false,
    prerequisites: ["funding-strategy", "pricing-model"],
    activationKeywords: ["bootstrap", "bootstrapped", "revenue first", "self-funded", "no investors"],
    firstQuestion: "What's the first paying customer, and how soon does revenue cover costs?",
  },
  {
    id: "grants-non-dilutive",
    pillar: "capital",
    label: "Grants and Non-dilutive Capital",
    description: "Grants, prizes, and non-dilutive funding sources.",
    icon: "Award",
    alwaysRelevant: false,
    prerequisites: [],
    activationKeywords: ["grant", "grants", "non-dilutive", "prize", "award", "subsidy"],
    firstQuestion: "Which grant or non-dilutive program fits the venture, and what's the application path?",
  },
];

// ──────────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────────

const BY_ID = PATTERNS.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});

const BY_PILLAR = PATTERNS.reduce((acc, p) => {
  if (!acc[p.pillar]) acc[p.pillar] = [];
  acc[p.pillar].push(p);
  return acc;
}, {});

export function getPattern(id) {
  return BY_ID[id] || null;
}

export function getPatternsByPillar(pillarKey) {
  return BY_PILLAR[pillarKey] || [];
}

export function findPatternMatches(text) {
  if (!text || typeof text !== "string") return [];
  const lower = text.toLowerCase();
  const scored = PATTERNS.map((p) => {
    const hits = (p.activationKeywords || []).filter((kw) => lower.includes(kw)).length;
    return { pattern: p, score: hits };
  }).filter((x) => x.score > 0);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.pattern);
}

export function arePrerequisitesMet(pattern, activatedIds) {
  if (!pattern || !pattern.prerequisites || pattern.prerequisites.length === 0) return true;
  const activeSet = new Set(activatedIds || []);
  return pattern.prerequisites.every((id) => activeSet.has(id));
}

export const LIBRARY_VERSION = 2;
