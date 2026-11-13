// The data contract between the keepers and the Housekeeper HQ site. Keepers write JSON in these shapes with `hq push`, which
// validates it here before it reaches R2; the site and the Worker read the same types. One schema per report type, so every
// run of a report renders with the same skeleton.
import { z } from "zod";

export const PROJECTS = ["awraq", "harium", "setup"] as const;
export const KEEPERS = ["housekeeper", "ops", "business"] as const;
export const RATINGS = ["very bad", "bad", "normal", "good", "very good"] as const;
export const GROUPS = ["Needs you", "To read", "Scheduled", "Watching"] as const;
export const REPORT_TYPES = ["ads", "product-health", "finance", "recap"] as const;
export const HOSTS = ["main-mac", "small-mac", "big-mac"] as const;

const Project = z.enum(PROJECTS);
const Keeper = z.enum(KEEPERS);
const Rating = z.enum(RATINGS);
const When = z.iso.datetime({ offset: true });
const Day = z.iso.date();
const Text = z.string().trim().min(1);
const Url = z.string().regex(/^(https?:|t3-thread:|#\/)/, "must be an http(s), t3-thread:, or #/ link");

export type Project = z.infer<typeof Project>;
export type Keeper = z.infer<typeof Keeper>;
export type Rating = z.infer<typeof Rating>;
export type ReportType = (typeof REPORT_TYPES)[number];
export type Host = (typeof HOSTS)[number];

export const RATING_EMOJI: Record<Rating, string> = {
  "very bad": "🔴",
  bad: "🟠",
  normal: "⚪",
  good: "🟢",
  "very good": "🌟",
};

// ---- status.json: open items from the Housekeeper's state, written by `hq push status` ----------------------------------

const Option = z.object({ key: Text, label: Text, tradeoff: z.string().optional(), recommended: z.boolean().optional() });
const Link = z.object({ label: Text, url: Url });

// The thread that asked a question from outside the keepers; picks go straight back to it.
const ThreadRef = z.object({ id: Text.max(200).regex(/^[\w:.-]+$/), host: z.enum(HOSTS), title: Text.max(120), link: Url });
export type ThreadRef = z.infer<typeof ThreadRef>;

export const StatusItem = z.object({
  id: Text,
  group: z.enum(GROUPS),
  projects: z.array(Project).min(1),
  owner: Keeper,
  title: Text,
  detail: z.string().optional(),
  options: z.array(Option).optional(),
  links: z.array(Link).default([]),
  // A report on this site ("#/reports/ads/2026-11-12") or a one-off share-html page.
  report: Url.optional(),
  rating: Rating.optional(),
  // What happens next, such as when a Scheduled item runs or what a Watching item waits on.
  next: z.string().optional(),
  // Decision letters the owner can answer in chat, such as ["BFE", "BFF"].
  letters: z.array(Text).default([]),
  createdAt: When,
  updatedAt: When,
  // When the Housekeeper last applied an answer; picks sent before it are already handled.
  appliedAt: When.optional(),
  // Set on questions any thread posts with `hq ask`; Needs you groups them by thread.
  thread: ThreadRef.optional(),
});
export type StatusItem = z.infer<typeof StatusItem>;
export type Option = z.infer<typeof Option>;

export const Status = z.object({ updatedAt: When, items: z.array(StatusItem) });
export type Status = z.infer<typeof Status>;

// ---- questions: questions/<id>.json, posted by any thread with `hq ask` ------------------------------------------------

// One question with one letter; its options are keyed by that letter, A1, A2, A3, and the last one leaves today's behavior.
export const Question = StatusItem.extend({
  id: Text.max(200).regex(/^q-[a-z0-9-]+$/, "question ids look like q-<letter>-<slug>"),
  group: z.literal("Needs you"),
  options: z.array(Option).min(2),
  letters: z.array(Text).length(1),
  thread: ThreadRef,
}).refine((q) => q.options.every((o) => new RegExp(`^${q.letters[0]}\\d+$`).test(o.key)), "option keys must be the letter plus a number, such as A1");
export type Question = z.infer<typeof Question>;

export const questionKey = (id: string) => `questions/${encodeURIComponent(id)}.json`;

// ---- answers: what the owner picked on the site, saved by the Worker ---------------------------------------------------

// A pick is an option key, or `skip`, `later`, `handled`, or `read`; an empty choice with no note clears the answer.
export const AnswerInput = z.object({
  id: Text.max(200),
  choice: z.string().max(40).default(""),
  note: z.string().max(4000).default(""),
});
export const Answer = AnswerInput.extend({ at: When, by: z.string().optional() });
export type Answer = z.infer<typeof Answer>;

// ---- reports: reports/<type>/<date>.json -------------------------------------------------------------------------------

const Money = z.object({ amount: z.number(), currency: Text });
export type Money = z.infer<typeof Money>;

// The first screen of every report: one rated headline and at most three findings ranked by users and money affected.
const Finding = z.object({ project: Project, rating: Rating.optional(), text: Text });
const Verdict = z.object({ rating: Rating, headline: Text, findings: z.array(Finding).max(3).default([]) });

const reportBase = {
  date: Day,
  owner: Keeper,
  verdict: Verdict,
  // Status item ids this report asks the owner to decide; the page shows their cards beside the report.
  decisions: z.array(Text).default([]),
  // How the numbers were read; shown collapsed.
  notes: z.array(Text).default([]),
};

const Platform = z.enum(["meta", "x", "google", "snap", "tiktok", "apple"]);
export type Platform = z.infer<typeof Platform>;
const PlatformDay = z.object({ spend: z.number(), results: z.number() });

const Campaign = z.object({
  platform: Platform,
  name: Text,
  state: z.enum(["running", "paused", "stopped", "off"]),
  budgetPerDay: Money.optional(),
  endsOn: Day.optional(),
  spend: Money.optional(),
  results: z.number().optional(),
  costPer: Money.optional(),
  rating: Rating.optional(),
  note: z.string().optional(),
});
export type Campaign = z.infer<typeof Campaign>;

const AdsProject = z.object({
  project: Project,
  // What one result is: "family" or "store tap".
  resultLabel: Text,
  resultPlural: Text,
  // The cost per result that stops spending, if any.
  line: Money.optional(),
  // The usual cost range when there is no line, such as "SAR 0.9–1.4".
  usual: z.string().optional(),
  total: z.object({
    spend: Money,
    results: z.number(),
    costPer: Money,
    rating: Rating,
    before: z.object({ spend: Money, results: z.number(), costPer: Money }).optional(),
  }),
  campaigns: z.array(Campaign),
  daily: z
    .array(z.object({ date: Day, spend: z.number(), results: z.number(), byPlatform: z.partialRecord(Platform, PlatformDay) }))
    .default([]),
});
export type AdsProject = z.infer<typeof AdsProject>;

export const AdsReport = z.object({
  type: z.literal("ads"),
  ...reportBase,
  period: z.object({ from: Day, to: Day }),
  projects: z.array(AdsProject).min(1),
});
export type AdsReport = z.infer<typeof AdsReport>;

// A metric row read against its usual range; rated only when it falls outside it.
const Metric = z.object({
  label: Text,
  values: z.array(z.string()),
  usual: z.string().optional(),
  rating: Rating.optional(),
  note: z.string().optional(),
});
export type Metric = z.infer<typeof Metric>;

export const ProductHealthReport = z.object({
  type: z.literal("product-health"),
  ...reportBase,
  // Data runs to the end of this day, Riyadh.
  dataTo: Day,
  // Column headings for each metric's values, such as ["Nov 10", "Nov 11"], and for its usual range.
  columns: z.array(Text).min(1),
  usualLabel: Text,
  projects: z.array(z.object({ project: Project, metrics: z.array(Metric), errors: z.string().optional() })).min(1),
  // Findings kept open from earlier runs, and the ones this run closed.
  carried: z
    .array(
      z.object({
        project: Project,
        title: Text,
        state: z.enum(["carried", "dropped", "closed"]),
        days: z.number().int().positive().optional(),
        why: Text,
      }),
    )
    .default([]),
});
export type ProductHealthReport = z.infer<typeof ProductHealthReport>;

const Line = z.object({
  label: Text,
  amount: Money,
  before: Money.optional(),
  rating: Rating.optional(),
  note: z.string().optional(),
});
export type Line = z.infer<typeof Line>;

export const FinanceReport = z.object({
  type: z.literal("finance"),
  ...reportBase,
  // The month reported, such as "2026-10".
  month: z.string().regex(/^\d{4}-\d{2}$/),
  projects: z
    .array(
      z.object({
        project: Project,
        revenue: z.array(Line),
        costs: z.array(Line),
        net: Line,
      }),
    )
    .min(1),
  // Monthly net per project for the trend chart, oldest first.
  history: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), net: z.partialRecord(Project, z.number()) })).default([]),
  currency: Text,
});
export type FinanceReport = z.infer<typeof FinanceReport>;

const RecapRow = z.object({
  project: Project,
  title: Text,
  // One plain line on what it is and why it matters or what happens next.
  text: Text,
  date: Day.optional(),
  url: Url.optional(),
});
export type RecapRow = z.infer<typeof RecapRow>;

export const RecapReport = z.object({
  type: z.literal("recap"),
  ...reportBase,
  since: When,
  until: When,
  live: z.array(z.object({ project: Project, sha: Text })).default([]),
  shipped: z.array(RecapRow).default([]),
  moving: z.array(RecapRow).default([]),
  handled: z.array(RecapRow).default([]),
  business: z.array(z.object({ project: Project, label: Text, value: Text, reference: z.string().optional(), rating: Rating.optional() })).default([]),
});
export type RecapReport = z.infer<typeof RecapReport>;

export const Report = z.discriminatedUnion("type", [AdsReport, ProductHealthReport, FinanceReport, RecapReport]);
export type Report = z.infer<typeof Report>;

/** The R2 key for a report. */
export const reportKey = (type: ReportType, date: string) => `reports/${type}/${date}.json`;
export const HQ_HOST = "hq.harium.app";
export const reportUrl = (type: ReportType, date: string) => `https://${HQ_HOST}/#/reports/${type}/${date}`;

// ---- pages: pages/<slug>.json, one-off reports, analyses, and option pages any thread pushes with `hq push page` ----------
// A page is a list of blocks that the site draws with its own components at hq.harium.app/p/<slug>, behind the same sign-in,
// with no expiry. An options block is a thread question: `hq push page` gives it a letter and posts it to Needs you, and the
// pick reaches the asking thread through `hq deliver`, whether Muhammed picks on the page or on the Status page.

export const RISKS = ["very low", "low", "medium", "high", "very high"] as const;
export const RISK_EMOJI: Record<(typeof RISKS)[number], string> = {
  "very low": "🌟",
  low: "🟢",
  medium: "⚪",
  high: "🟠",
  "very high": "🔴",
};
export const PR_STATES = [
  "merged",
  "closed",
  "draft",
  "conflicts",
  "checks failing",
  "merging now",
  "checks running",
  "needs you",
  "ready to merge",
] as const;

const Cell = z.union([z.string(), z.object({ text: z.string().default(""), rating: Rating.optional() })]);
export type Cell = z.infer<typeof Cell>;
// Sandboxed HTML: scripts run, but the frame cannot reach hq's data or sign-in.
const Html = z.string().min(1).max(2_000_000);
const Image = z.string().regex(/^(https:|data:image\/)/, "must be an https: or data:image/ URL");

const PageOption = z.object({
  key: z.string().optional(),
  label: Text,
  tradeoff: z.string().optional(),
  recommended: z.boolean().optional(),
  // A mockup or diagram of the option, drawn in a sandboxed frame, or a screenshot.
  html: Html.optional(),
  image: Image.optional(),
});
export type PageOption = z.infer<typeof PageOption>;

export const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("verdict"), rating: Rating, headline: Text, findings: z.array(Finding.partial({ project: true })).max(3).default([]) }),
  z.object({ type: z.literal("section"), title: Text, caption: z.string().optional() }),
  z.object({ type: z.literal("text"), text: Text }),
  z.object({
    type: z.literal("stats"),
    items: z
      .array(
        z.object({
          label: Text,
          value: Text,
          before: z.string().optional(),
          rating: Rating.optional(),
          // What the rating judges against, such as "of the SAR 5 stop line".
          reference: z.string().optional(),
          project: Project.optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    type: z.literal("table"),
    title: z.string().optional(),
    caption: z.string().optional(),
    columns: z.array(Text).min(1),
    // Each row starts with its emoji, such as a platform or a day.
    rows: z.array(z.object({ emoji: z.string().optional(), cells: z.array(Cell) })).min(1),
  }),
  z.object({
    type: z.literal("chart"),
    kind: z.enum(["line", "bar", "area"]).default("line"),
    title: z.string().optional(),
    caption: z.string().optional(),
    x: z.array(z.string()).min(1),
    series: z.array(z.object({ label: Text, values: z.array(z.number().nullable()), project: Project.optional() })).min(1),
    unit: z.string().optional(),
  }),
  z.object({
    type: z.literal("prs"),
    title: z.string().optional(),
    items: z
      .array(
        z.object({
          state: z.enum(PR_STATES),
          number: z.number().int().positive(),
          title: Text,
          url: Url,
          context: Text,
          risk: z.enum(RISKS),
          riskReason: Text,
          opinion: Text,
        }),
      )
      .min(1),
  }),
  z.object({
    type: z.literal("options"),
    // Stable across pushes, so a re-pushed page keeps its letter and question.
    id: z.string().regex(/^[a-z0-9-]+$/).default("options"),
    title: Text,
    context: z.string().optional(),
    // Muhammed may pick several options, which the thread combines.
    multiple: z.boolean().default(true),
    options: z.array(PageOption).min(2),
    // Set by `hq push page`.
    letter: z.string().regex(/^[A-Z]$/).optional(),
    question: z.string().optional(),
  }),
  z.object({ type: z.literal("html"), title: z.string().optional(), caption: z.string().optional(), html: Html, height: z.number().int().min(80).max(4000).optional() }),
  z.object({ type: z.literal("details"), title: Text, items: z.array(Text).min(1) }),
]);
export type Block = z.infer<typeof Block>;
export type OptionsBlock = Extract<Block, { type: "options" }>;

export const Page = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/, "slugs are 3-80 lowercase letters, digits, and dashes"),
    title: Text.max(120),
    // One line under the title on what the page is for.
    description: z.string().optional(),
    projects: z.array(Project).min(1),
    // The thread that pushed it; options picks go back to it.
    thread: ThreadRef.optional(),
    blocks: z.array(Block).min(1),
    createdAt: When.optional(),
    updatedAt: When.optional(),
  })
  .refine(
    (p) => new Set(p.blocks.flatMap((b) => (b.type === "options" ? [b.id] : []))).size === p.blocks.filter((b) => b.type === "options").length,
    "each options block needs its own id",
  );
export type Page = z.infer<typeof Page>;

export const pageKey = (slug: string) => `pages/${slug}.json`;
export const pageUrl = (slug: string) => `https://${HQ_HOST}/p/${slug}`;
// A page question's pick, kept after `hq deliver` closes the question so the page still shows what Muhammed picked.
export const pagePickKey = (id: string) => `page-picks/${encodeURIComponent(id)}.json`;
