// The data contract between the keepers and the Housekeeper HQ site. Keepers write JSON in these shapes with `hq push`, which
// validates it here before it reaches R2; the site and the Worker read the same types. One schema per report type, so every
// run of a report renders with the same skeleton.
import { z } from "zod";

export const PROJECTS = ["awraq", "harium", "setup"] as const;
export const KEEPERS = ["housekeeper", "ops", "business"] as const;
export const RATINGS = ["very bad", "bad", "normal", "good", "very good"] as const;
export const GROUPS = ["Needs you", "To read", "Scheduled", "Watching"] as const;
export const REPORT_TYPES = ["ads", "product-health", "finance", "recap"] as const;

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
});
export type StatusItem = z.infer<typeof StatusItem>;
export type Option = z.infer<typeof Option>;

export const Status = z.object({ updatedAt: When, items: z.array(StatusItem) });
export type Status = z.infer<typeof Status>;

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
