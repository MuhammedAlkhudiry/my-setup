import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ADS_PROJECTS, type AdsProjectDefinition, type AdsProjectPlatform } from "../../config/ads";

export const AD_PLATFORMS = ["google", "meta", "snapchat", "tiktok", "apple"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
export type AdAccessState = "ready" | "pending" | "browser" | "unavailable" | "error";
export type AdsPeriod = "7d" | "30d";

export type AdAccount = {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
};

export type AdAccess = {
  platform: AdPlatform;
  platformName: string;
  state: AdAccessState;
  configured: boolean;
  account: AdAccount | null;
  message: string | null;
  checkedAt: string;
};

export type AdCampaign = {
  id: string;
  name: string;
  status: string;
  deliveryStatus: string | null;
  objective: string | null;
  startAt: string | null;
  endAt: string | null;
};

export type NativeMetric = {
  name: string;
  value: number;
};

export type DailyStats = {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  nativeConversions: NativeMetric[];
};

export type PlatformStats = AdAccess & {
  period: AdsPeriod;
  range: { from: string; to: string } | null;
  attribution: string | null;
  freshness: {
    fetchedAt: string;
    providerUpdatedAt: string | null;
    note: string | null;
  };
  metrics: {
    impressions: number;
    clicks: number;
    spend: number;
    nativeConversions: NativeMetric[];
  } | null;
  daily: DailyStats[];
};

export type PlatformCampaigns = AdAccess & {
  campaigns: AdCampaign[];
};

export type AdsStatusDocument = {
  contractVersion: 1;
  generatedAt: string;
  cached: boolean;
  platforms: AdAccess[];
};

export type AdsStatsDocument = {
  contractVersion: 1;
  generatedAt: string;
  cached: boolean;
  period: AdsPeriod;
  platforms: PlatformStats[];
};

export type AdsCampaignsDocument = {
  contractVersion: 1;
  generatedAt: string;
  cached: boolean;
  activeOnly: boolean;
  platforms: PlatformCampaigns[];
};

export type AdsProjectsDocument = {
  contractVersion: 1;
  projects: Array<{
    id: string;
    name: string;
    classification: "project" | "unassigned";
    platforms: AdPlatform[];
  }>;
};

type JsonObject = Record<string, unknown>;
type Provider = {
  platform: AdPlatform;
  status(): Promise<AdAccess>;
  stats(period: AdsPeriod, campaignID?: string): Promise<PlatformStats>;
  campaigns(activeOnly: boolean): Promise<PlatformCampaigns>;
};

const PLATFORM_NAMES: Record<AdPlatform, string> = {
  google: "Google Ads",
  meta: "Meta Ads",
  snapchat: "Snapchat Ads",
  tiktok: "TikTok Ads",
  apple: "Apple Ads",
};
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_ROOT = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "my-setup", "ads");
const CREDENTIALS_ROOT =
  process.env.SERVICE_CREDENTIALS_HOME || join(homedir(), ".config", "my-setup", "credentials");

export function parsePlatform(value: string | undefined): AdPlatform | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[-_\s]+ads?$/, "");
  const aliases: Record<string, AdPlatform> = {
    google: "google",
    meta: "meta",
    facebook: "meta",
    snapchat: "snapchat",
    snap: "snapchat",
    tiktok: "tiktok",
    apple: "apple",
  };
  const platform = aliases[normalized];
  if (!platform) {
    throw new Error(`Unknown platform "${value}". Use: ${AD_PLATFORMS.join(", ")}.`);
  }
  return platform;
}

export function parsePeriod(value: string | undefined): AdsPeriod {
  if (!value || value === "7d") return "7d";
  if (value === "30d") return "30d";
  throw new Error('Period must be "7d" or "30d".');
}

export function parseProject(value: string | undefined): string | undefined {
  if (!value || value === "all") return undefined;
  if (!ADS_PROJECTS.some(({ id }) => id === value)) {
    throw new Error(
      `Unknown project "${value}". Use: ${ADS_PROJECTS.map(({ id }) => id).join(", ")}.`,
    );
  }
  return value;
}

export function parseCampaign(value: string | number | undefined): string | undefined {
  if (!value || value === "all") return undefined;
  const campaignID = String(value).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(campaignID)) {
    throw new Error("Campaign ID may contain only letters, numbers, hyphens, and underscores.");
  }
  return campaignID;
}

export function adsProjects(): AdsProjectsDocument {
  return {
    contractVersion: 1,
    projects: ADS_PROJECTS.map(({ id, name, classification, platforms }) => ({
      id,
      name,
      classification,
      platforms: AD_PLATFORMS.filter((platform) => Boolean(platforms[platform])),
    })),
  };
}

export async function adsStatus(options: {
  platform?: AdPlatform;
  project?: string;
  refresh?: boolean;
}): Promise<AdsStatusDocument> {
  const project = projectDefinition(options.project);
  const platforms = selectedPlatforms(options.platform, project);
  return cachedDocument(
    `status-${options.project || "all"}-${platforms.join("-") || "none"}`,
    Boolean(options.refresh),
    async (): Promise<AdsStatusDocument> => ({
      contractVersion: 1,
      generatedAt: now(),
      cached: false,
      platforms: await Promise.all(
        platforms.map((platform) => provider(platform, project?.platforms[platform]).status()),
      ),
    }),
  );
}

export async function adsStats(options: {
  period: AdsPeriod;
  platform?: AdPlatform;
  project?: string;
  campaign?: string;
  refresh?: boolean;
}): Promise<AdsStatsDocument> {
  if (options.campaign && !options.platform) {
    throw new Error("A campaign filter requires one platform.");
  }
  const project = projectDefinition(options.project);
  const platforms = selectedPlatforms(options.platform, project);
  return cachedDocument(
    `stats-${options.project || "all"}-${options.period}-${options.campaign || "all-campaigns"}-${platforms.join("-") || "none"}`,
    Boolean(options.refresh),
    async (): Promise<AdsStatsDocument> => ({
      contractVersion: 1,
      generatedAt: now(),
      cached: false,
      period: options.period,
      platforms: await Promise.all(
        platforms.map((platform) =>
          provider(platform, project?.platforms[platform]).stats(options.period, options.campaign),
        ),
      ),
    }),
  );
}

export async function adsCampaigns(options: {
  activeOnly: boolean;
  platform?: AdPlatform;
  project?: string;
  refresh?: boolean;
}): Promise<AdsCampaignsDocument> {
  const project = projectDefinition(options.project);
  const platforms = selectedPlatforms(options.platform, project);
  return cachedDocument(
    `campaigns-${options.project || "all"}-${options.activeOnly ? "active" : "all"}-${platforms.join("-") || "none"}`,
    Boolean(options.refresh),
    async (): Promise<AdsCampaignsDocument> => ({
      contractVersion: 1,
      generatedAt: now(),
      cached: false,
      activeOnly: options.activeOnly,
      platforms: await Promise.all(
        platforms.map((platform) =>
          provider(platform, project?.platforms[platform]).campaigns(options.activeOnly),
        ),
      ),
    }),
  );
}

export function platformDashboard(platform: AdPlatform): string {
  return {
    google: "https://ads.google.com/",
    meta: "https://www.facebook.com/ads/manager",
    snapchat: "https://ads.snapchat.com/",
    tiktok: "https://business.tiktok.com/",
    apple: "https://app-ads.apple.com/cm/app/",
  }[platform];
}

function projectDefinition(project?: string): AdsProjectDefinition | undefined {
  return project ? ADS_PROJECTS.find(({ id }) => id === project) : undefined;
}

function selectedPlatforms(
  platform: AdPlatform | undefined,
  project: AdsProjectDefinition | undefined,
): AdPlatform[] {
  const available = project
    ? AD_PLATFORMS.filter((candidate) => Boolean(project.platforms[candidate]))
    : [...AD_PLATFORMS];
  return platform ? available.filter((candidate) => candidate === platform) : available;
}

function allowedCampaignID(
  campaignID: string | undefined,
  mapping: AdsProjectPlatform | undefined,
): string | undefined {
  if (!campaignID) return undefined;
  if (mapping?.campaignIds?.length && !mapping.campaignIds.includes(campaignID)) {
    throw new Error(`Campaign "${campaignID}" is not mapped to the selected project.`);
  }
  return campaignID;
}

function provider(platform: AdPlatform, mapping?: AdsProjectPlatform): Provider {
  if (platform === "google") return googleProvider(mapping);
  if (platform === "meta") return metaProvider(mapping);
  if (platform === "snapchat") return snapchatProvider(mapping);
  if (platform === "tiktok") return tiktokProvider(mapping);
  return unavailableProvider(mapping);
}

function unavailableProvider(mapping?: AdsProjectPlatform): Provider {
  const platform = "apple";
  const credentialPath = "apple-ads/oauth.json";
  const message = `${PLATFORM_NAMES[platform]} API credentials are not configured at ${credentialPath}.`;
  const access = (): AdAccess => ({
    platform,
    platformName: PLATFORM_NAMES[platform],
    state: mapping?.access?.state ?? "unavailable",
    configured: false,
    account: mapping?.access?.account ?? null,
    message: mapping?.access?.message ?? message,
    checkedAt: now(),
  });
  return {
    platform,
    status: async () => access(),
    stats: async (period) => emptyStats(access(), period),
    campaigns: async () => ({ ...access(), campaigns: [] }),
  };
}

function googleProvider(mapping?: AdsProjectPlatform): Provider {
  return {
    platform: "google",
    async status() {
      return safeAccess("google", true, async () => {
        const client = await googleClient();
        return ensureMappedAccount(client.account, mapping);
      });
    },
    async stats(period, campaignID) {
      const checkedAt = now();
      try {
        const client = await googleClient();
        const account = ensureMappedAccount(client.account, mapping);
        const range = reportingRange(period, account.timezone);
        const campaignCondition = googleCampaignCondition(mapping, campaignID);
        const rows = await client.query(
          `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.all_conversions, metrics.view_through_conversions, metrics.biddable_app_install_conversions FROM campaign WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'${campaignCondition}`,
        );
        const daily = groupedDailyStats(rows, range, {
          date: "segments.date",
          impressions: "metrics.impressions",
          clicks: "metrics.clicks",
          spend: (row) => numberAt(row, "metrics.costMicros") / 1_000_000,
          conversions: [
            ["metrics.conversions", "conversions"],
            ["metrics.allConversions", "all_conversions"],
            ["metrics.viewThroughConversions", "view_through_conversions"],
            ["metrics.biddableAppInstallConversions", "biddable_app_install_conversions"],
          ],
        });
        return readyStats("google", account, period, range, {
          attribution:
            "Google Ads account conversion actions and their configured attribution settings",
          impressions: sum(rows, "metrics.impressions"),
          clicks: sum(rows, "metrics.clicks"),
          spend: round(sum(rows, "metrics.costMicros") / 1_000_000),
          nativeConversions: nativeMetrics(rows, [
            ["metrics.conversions", "conversions"],
            ["metrics.allConversions", "all_conversions"],
            ["metrics.viewThroughConversions", "view_through_conversions"],
            ["metrics.biddableAppInstallConversions", "biddable_app_install_conversions"],
          ]),
          checkedAt,
          daily,
          freshnessNote:
            "Google Ads does not expose one report-wide finalized timestamp; recent conversion totals may restate.",
        });
      } catch (error) {
        return emptyStats(errorAccess("google", true, error), period);
      }
    },
    async campaigns(activeOnly) {
      try {
        const client = await googleClient();
        const account = ensureMappedAccount(client.account, mapping);
        const conditions = [
          ...(activeOnly ? ["campaign.status = 'ENABLED'"] : []),
          ...(mapping?.campaignIds?.length
            ? [`campaign.id IN (${mapping.campaignIds.join(", ")})`]
            : []),
        ];
        const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
        const rows = await client.query(
          `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.advertising_channel_type FROM campaign${where}`,
        );
        return {
          ...readyAccess("google", account),
          campaigns: rows.map((row) => ({
            id: stringAt(row, "campaign.id"),
            name: stringAt(row, "campaign.name"),
            status: stringAt(row, "campaign.status"),
            deliveryStatus: nullableStringAt(row, "campaign.primaryStatus"),
            objective: nullableStringAt(row, "campaign.advertisingChannelType"),
            startAt: null,
            endAt: null,
          })),
        };
      } catch (error) {
        return { ...errorAccess("google", true, error), campaigns: [] };
      }
    },
  };
}

function googleCampaignCondition(mapping?: AdsProjectPlatform, campaignID?: string): string {
  const selectedCampaignID = allowedCampaignID(campaignID, mapping);
  if (selectedCampaignID) {
    if (!/^\d+$/.test(selectedCampaignID)) {
      throw new Error(`Google Ads campaign ID "${selectedCampaignID}" must be numeric.`);
    }
    return ` AND campaign.id = ${selectedCampaignID}`;
  }
  return mapping?.campaignIds?.length
    ? ` AND campaign.id IN (${mapping.campaignIds.join(", ")})`
    : "";
}

async function googleClient(): Promise<{
  account: AdAccount;
  query(query: string): Promise<JsonObject[]>;
}> {
  const env = await secretEnvironment();
  const required = [
    "GOOGLE_ADS_API_VERSION",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_CUSTOMER_ID",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_REFRESH_TOKEN",
  ] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}.`);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const tokenBody = await jsonResponse(tokenResponse);
  const accessToken = stringAt(tokenBody, "access_token");
  if (!tokenResponse.ok || !accessToken) {
    throw apiError("Google OAuth", tokenResponse, tokenBody);
  }

  const customerID = env.GOOGLE_ADS_CUSTOMER_ID.replaceAll("-", "");
  const query = async (gaql: string): Promise<JsonObject[]> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
    };
    if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers["login-customer-id"] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replaceAll("-", "");
    }
    const response = await fetch(
      `https://googleads.googleapis.com/${env.GOOGLE_ADS_API_VERSION}/customers/${customerID}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query: gaql }) },
    );
    const body = await jsonResponse(response);
    if (!response.ok || !Array.isArray(body)) throw apiError("Google Ads", response, body);
    return body.flatMap((batch) =>
      Array.isArray(asObject(batch).results)
        ? (asObject(batch).results as unknown[]).map(asObject)
        : [],
    );
  };

  const rows = await query(
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
  );
  const row = rows[0];
  return {
    account: {
      id: nullableStringAt(row, "customer.id") || customerID,
      name: nullableStringAt(row, "customer.descriptiveName"),
      currency: nullableStringAt(row, "customer.currencyCode"),
      timezone: nullableStringAt(row, "customer.timeZone"),
    },
    query,
  };
}

function metaProvider(_mapping?: AdsProjectPlatform): Provider {
  return {
    platform: "meta",
    async status() {
      return safeAccess("meta", await credentialExists("meta-ads/system-user.json"), async () =>
        ensureMappedAccount(await metaAccount(), _mapping),
      );
    },
    async stats(period, campaignID) {
      try {
        const credential = await readCredential("meta-ads/system-user.json");
        const account = ensureMappedAccount(await metaAccount(), _mapping);
        const selectedCampaignID = allowedCampaignID(campaignID, _mapping);
        const range = reportingRange(period, account.timezone);
        const query = new URLSearchParams({
          access_token: stringAt(credential, "access_token"),
          level: selectedCampaignID ? "campaign" : "account",
          fields: "impressions,clicks,spend,actions,action_values,date_start,date_stop",
          time_range: JSON.stringify({ since: range.from, until: range.to }),
          use_account_attribution_setting: "true",
          time_increment: "1",
          limit: "100",
        });
        if (!selectedCampaignID && _mapping?.campaignIds?.length) {
          query.set(
            "filtering",
            JSON.stringify([{ field: "campaign.id", operator: "IN", value: _mapping.campaignIds }]),
          );
        }
        const insightsOwner = selectedCampaignID || `act_${stringAt(credential, "ad_account_id")}`;
        const body = await metaGet(`${insightsOwner}/insights`, query);
        const rows = objectsAt(body, "data");
        const daily = rows.map((row) => ({
          date: stringAt(row, "date_start"),
          impressions: numberAt(row, "impressions"),
          clicks: numberAt(row, "clicks"),
          spend: numberAt(row, "spend"),
          nativeConversions: objectsAt(row, "actions").map((action) => ({
            name: stringAt(action, "action_type"),
            value: numberAt(action, "value"),
          })),
        }));
        const actions = mergeNativeMetrics(
          daily.flatMap(({ nativeConversions }) => nativeConversions),
        );
        return readyStats("meta", account, period, range, {
          attribution: "Meta account attribution setting (use_account_attribution_setting=true)",
          impressions: daily.reduce((total, row) => total + row.impressions, 0),
          clicks: daily.reduce((total, row) => total + row.clicks, 0),
          spend: daily.reduce((total, row) => total + row.spend, 0),
          nativeConversions: actions,
          checkedAt: now(),
          daily: fillDailyRange(daily, range),
          freshnessNote:
            "Meta action names are preserved individually; action values are not combined.",
        });
      } catch (error) {
        return emptyStats(
          errorAccess("meta", await credentialExists("meta-ads/system-user.json"), error),
          period,
        );
      }
    },
    async campaigns(activeOnly) {
      const configured = await credentialExists("meta-ads/system-user.json");
      try {
        const credential = await readCredential("meta-ads/system-user.json");
        const account = ensureMappedAccount(await metaAccount(), _mapping);
        const query = new URLSearchParams({
          access_token: stringAt(credential, "access_token"),
          fields: "id,name,status,effective_status,objective,start_time,stop_time",
          limit: "500",
        });
        const body = await metaGet(`act_${stringAt(credential, "ad_account_id")}/campaigns`, query);
        const campaigns = objectsAt(body, "data")
          .filter(
            (row) =>
              !activeOnly ||
              (stringAt(row, "effective_status") === "ACTIVE" &&
                (!nullableStringAt(row, "stop_time") ||
                  Date.parse(stringAt(row, "stop_time")) > Date.now())),
          )
          .filter(
            (row) =>
              !_mapping?.campaignIds?.length || _mapping.campaignIds.includes(stringAt(row, "id")),
          )
          .map((row) => ({
            id: stringAt(row, "id"),
            name: stringAt(row, "name"),
            status: stringAt(row, "status"),
            deliveryStatus: nullableStringAt(row, "effective_status"),
            objective: nullableStringAt(row, "objective"),
            startAt: nullableStringAt(row, "start_time"),
            endAt: nullableStringAt(row, "stop_time"),
          }));
        return { ...readyAccess("meta", account), campaigns };
      } catch (error) {
        return { ...errorAccess("meta", configured, error), campaigns: [] };
      }
    },
  };
}

async function metaAccount(): Promise<AdAccount> {
  const credential = await readCredential("meta-ads/system-user.json");
  const accountID = stringAt(credential, "ad_account_id").replace(/^act_/, "");
  const query = new URLSearchParams({
    access_token: stringAt(credential, "access_token"),
    fields: "id,name,currency,timezone_name,account_status",
  });
  const body = await metaGet(`act_${accountID}`, query);
  return {
    id: nullableStringAt(body, "id")?.replace(/^act_/, "") || accountID,
    name: nullableStringAt(body, "name") || nullableStringAt(credential, "ad_account_name"),
    currency: nullableStringAt(body, "currency"),
    timezone: nullableStringAt(body, "timezone_name"),
  };
}

async function metaGet(path: string, query: URLSearchParams): Promise<JsonObject> {
  const response = await fetch(`https://graph.facebook.com/v24.0/${path}?${query}`);
  const body = await jsonResponse(response);
  if (!response.ok || asObject(body).error) throw apiError("Meta Ads", response, body);
  return asObject(body);
}

function snapchatProvider(mapping?: AdsProjectPlatform): Provider {
  return {
    platform: "snapchat",
    async status() {
      return safeAccess("snapchat", await credentialExists("snapchat-ads/oauth.json"), async () =>
        ensureMappedAccount(await snapchatAccount(), mapping),
      );
    },
    async stats(period, campaignID) {
      const configured = await credentialExists("snapchat-ads/oauth.json");
      try {
        const { credential, token } = await snapchatCredential();
        const account = ensureMappedAccount(await snapchatAccount(credential, token), mapping);
        const range = reportingRange(period, account.timezone);
        const campaignBody = await snapchatGet(
          `adaccounts/${stringAt(credential, "ad_account_id")}/campaigns?limit=1000`,
          token,
        );
        const availableCampaignIDs = objectsAt(campaignBody, "campaigns")
          .map((wrapper) => stringAt(wrapper, "campaign.id"))
          .filter(Boolean);
        const selectedCampaignID = allowedCampaignID(campaignID, mapping);
        const campaignIDs = selectedCampaignID
          ? availableCampaignIDs.filter((id) => id === selectedCampaignID)
          : mapping?.campaignIds?.length
            ? availableCampaignIDs.filter((id) => mapping.campaignIds?.includes(id))
            : availableCampaignIDs;
        const query = new URLSearchParams({
          granularity: "DAY",
          start_time: zonedMidnightIso(range.from, account.timezone),
          end_time: zonedMidnightIso(nextDate(range.to), account.timezone),
          fields: "impressions,swipes,spend,conversion_purchases,conversion_sign_ups,native_leads",
          action_report_time: "conversion",
          swipe_up_attribution_window: "28_DAY",
          engaged_view_attribution_window: "2_DAY",
          view_attribution_window: "1_DAY",
        });
        const reports = await Promise.all(
          campaignIDs.map(async (campaignID) => {
            const body = await snapchatGet(`campaigns/${campaignID}/stats?${query}`, token);
            return asObject(objectsAt(body, "timeseries_stats")[0]?.timeseries_stat);
          }),
        );
        const metricRows = reports.flatMap((report) =>
          objectsAt(report, "timeseries").map((row) => ({
            ...asObject(row.stats),
            date: nullableStringAt(row, "start_time")?.slice(0, 10),
          })),
        );
        const daily = groupedDailyStats(metricRows, range, {
          date: "date",
          impressions: "impressions",
          clicks: "swipes",
          spend: (row) => numberAt(row, "spend") / 1_000_000,
          conversions: [
            ["conversion_purchases", "conversion_purchases"],
            ["conversion_sign_ups", "conversion_sign_ups"],
            ["native_leads", "native_leads"],
          ],
        });
        const providerUpdatedAt = reports
          .map(
            (report) =>
              nullableStringAt(report, "conversion_data_processed_end_time") ||
              nullableStringAt(report, "finalized_data_end_time"),
          )
          .filter((value): value is string => Boolean(value))
          .sort()[0];
        return readyStats("snapchat", account, period, range, {
          attribution:
            "conversion time; 28-day swipe-up, 2-day engaged-view, and 1-day view attribution windows",
          impressions: sum(metricRows, "impressions"),
          clicks: sum(metricRows, "swipes"),
          spend: round(sum(metricRows, "spend") / 1_000_000),
          nativeConversions: [
            {
              name: "conversion_purchases",
              value: sum(metricRows, "conversion_purchases"),
            },
            {
              name: "conversion_sign_ups",
              value: sum(metricRows, "conversion_sign_ups"),
            },
            { name: "native_leads", value: sum(metricRows, "native_leads") },
          ],
          checkedAt: now(),
          daily,
          providerUpdatedAt,
          freshnessNote:
            "Snap reports approximate 15-minute updates and exposes finalization timestamps when available.",
        });
      } catch (error) {
        return emptyStats(errorAccess("snapchat", configured, error), period);
      }
    },
    async campaigns(activeOnly) {
      const configured = await credentialExists("snapchat-ads/oauth.json");
      try {
        const { credential, token } = await snapchatCredential();
        const account = ensureMappedAccount(await snapchatAccount(credential, token), mapping);
        const body = await snapchatGet(
          `adaccounts/${stringAt(credential, "ad_account_id")}/campaigns?limit=1000`,
          token,
        );
        const campaigns = objectsAt(body, "campaigns")
          .map((wrapper) => asObject(wrapper.campaign))
          .filter(
            (row) =>
              !activeOnly ||
              (stringAt(row, "status") === "ACTIVE" &&
                !stringAt(row, "delivery_status").startsWith("INVALID_")),
          )
          .filter(
            (row) =>
              !mapping?.campaignIds?.length || mapping.campaignIds.includes(stringAt(row, "id")),
          )
          .map((row) => ({
            id: stringAt(row, "id"),
            name: stringAt(row, "name"),
            status: stringAt(row, "status"),
            deliveryStatus: nullableStringAt(row, "delivery_status"),
            objective:
              nullableStringAt(row, "objective_v2_properties.objective_v2_type") ||
              nullableStringAt(row, "objective"),
            startAt: nullableStringAt(row, "start_time"),
            endAt: nullableStringAt(row, "end_time"),
          }));
        return { ...readyAccess("snapchat", account), campaigns };
      } catch (error) {
        return { ...errorAccess("snapchat", configured, error), campaigns: [] };
      }
    },
  };
}

async function snapchatCredential(): Promise<{ credential: JsonObject; token: string }> {
  const path = credentialPath("snapchat-ads/oauth.json");
  const credential = await readCredential("snapchat-ads/oauth.json");
  const created = Date.parse(stringAt(credential, "created_at"));
  const expiresIn = numberAt(credential, "expires_in");
  const expiresAt = created + expiresIn * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + 60_000) {
    return { credential, token: stringAt(credential, "access_token") };
  }
  const response = await fetch("https://accounts.snapchat.com/login/oauth2/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: stringAt(credential, "client_id"),
      client_secret: stringAt(credential, "client_secret"),
      refresh_token: stringAt(credential, "refresh_token"),
      grant_type: "refresh_token",
    }),
  });
  const body = await jsonResponse(response);
  if (!response.ok || !nullableStringAt(body, "access_token")) {
    throw apiError("Snapchat OAuth", response, body);
  }
  const updated = {
    ...credential,
    access_token: stringAt(body, "access_token"),
    refresh_token: nullableStringAt(body, "refresh_token") || credential.refresh_token,
    token_type: nullableStringAt(body, "token_type") || credential.token_type,
    expires_in: numberAt(body, "expires_in") || credential.expires_in,
    created_at: now(),
  };
  await atomicPrivateJSON(path, updated);
  return { credential: updated, token: stringAt(updated, "access_token") };
}

async function snapchatAccount(
  existingCredential?: JsonObject,
  existingToken?: string,
): Promise<AdAccount> {
  const auth =
    existingCredential && existingToken
      ? { credential: existingCredential, token: existingToken }
      : await snapchatCredential();
  const accountID = stringAt(auth.credential, "ad_account_id");
  const body = await snapchatGet(`adaccounts/${accountID}`, auth.token);
  const account = asObject(objectsAt(body, "adaccounts")[0]?.adaccount);
  return {
    id: nullableStringAt(account, "id") || accountID,
    name: nullableStringAt(account, "name"),
    currency: nullableStringAt(account, "currency"),
    timezone: nullableStringAt(account, "timezone"),
  };
}

async function snapchatGet(path: string, token: string): Promise<JsonObject> {
  const response = await fetch(`https://adsapi.snapchat.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await jsonResponse(response);
  if (!response.ok || String(asObject(body).request_status || "").toUpperCase() === "ERROR") {
    throw apiError("Snapchat Ads", response, body);
  }
  return asObject(body);
}

function tiktokProvider(mapping?: AdsProjectPlatform): Provider {
  return {
    platform: "tiktok",
    async status() {
      return safeAccess("tiktok", await credentialExists("tiktok-ads/oauth.json"), async () =>
        ensureMappedAccount(await tiktokAccount(), mapping),
      );
    },
    async stats(period, campaignID) {
      const configured = await credentialExists("tiktok-ads/oauth.json");
      try {
        const credential = await readCredential("tiktok-ads/oauth.json");
        const account = ensureMappedAccount(await tiktokAccount(credential), mapping);
        const range = reportingRange(period, account.timezone);
        const selectedCampaignID = allowedCampaignID(campaignID, mapping);
        const campaignIDs = selectedCampaignID
          ? [selectedCampaignID]
          : mapping?.campaignIds?.length
            ? [...mapping.campaignIds]
            : null;
        const rows = (await tiktokReport(credential, range)).filter((row) => {
          const id = stringAt(row, "dimensions.campaign_id");
          return !campaignIDs || campaignIDs.includes(id);
        });
        const normalizedRows = rows.map((row) => ({
          date: stringAt(row, "dimensions.stat_time_day").slice(0, 10),
          impressions: numberAt(row, "metrics.impressions"),
          clicks: numberAt(row, "metrics.clicks"),
          spend: numberAt(row, "metrics.spend"),
          conversion: numberAt(row, "metrics.conversion"),
          real_time_conversion: numberAt(row, "metrics.real_time_conversion"),
        }));
        const daily = groupedDailyStats(normalizedRows, range, {
          date: "date",
          impressions: "impressions",
          clicks: "clicks",
          spend: (row) => numberAt(row, "spend"),
          conversions: [
            ["conversion", "conversion"],
            ["real_time_conversion", "real_time_conversion"],
          ],
        });
        return readyStats("tiktok", account, period, range, {
          attribution:
            "TikTok Ads Manager attribution settings; conversion is reported by impression time and real_time_conversion by conversion time",
          impressions: sum(normalizedRows, "impressions"),
          clicks: sum(normalizedRows, "clicks"),
          spend: sum(normalizedRows, "spend"),
          nativeConversions: nativeMetrics(normalizedRows, [
            ["conversion", "conversion"],
            ["real_time_conversion", "real_time_conversion"],
          ]),
          checkedAt: now(),
          daily,
          freshnessNote:
            "TikTok reporting can restate recent conversion data; the range excludes the current account day.",
        });
      } catch (error) {
        return emptyStats(errorAccess("tiktok", configured, error), period);
      }
    },
    async campaigns(activeOnly) {
      const configured = await credentialExists("tiktok-ads/oauth.json");
      try {
        const credential = await readCredential("tiktok-ads/oauth.json");
        const account = ensureMappedAccount(await tiktokAccount(credential), mapping);
        const campaigns = (await tiktokCampaigns(credential))
          .filter(
            (row) =>
              !mapping?.campaignIds?.length ||
              mapping.campaignIds.includes(stringAt(row, "campaign_id")),
          )
          .filter(
            (row) =>
              !activeOnly ||
              (stringAt(row, "operation_status") === "ENABLE" &&
                stringAt(row, "secondary_status") === "CAMPAIGN_STATUS_ENABLE"),
          )
          .map((row) => ({
            id: stringAt(row, "campaign_id"),
            name: stringAt(row, "campaign_name"),
            status: stringAt(row, "operation_status"),
            deliveryStatus: nullableStringAt(row, "secondary_status"),
            objective: nullableStringAt(row, "objective_type"),
            startAt: null,
            endAt: null,
          }));
        return { ...readyAccess("tiktok", account), campaigns };
      } catch (error) {
        return { ...errorAccess("tiktok", configured, error), campaigns: [] };
      }
    },
  };
}

async function tiktokAccount(existingCredential?: JsonObject): Promise<AdAccount> {
  const credential = existingCredential ?? (await readCredential("tiktok-ads/oauth.json"));
  const advertiserID = stringAt(credential, "advertiser_id");
  const authorized = await tiktokGet(
    "oauth2/advertiser/get/",
    new URLSearchParams({
      app_id: stringAt(credential, "app_id"),
      secret: stringAt(credential, "app_secret"),
    }),
    stringAt(credential, "access_token"),
  );
  const authorizedAccount = objectsAt(authorized, "data.list").find(
    (row) => stringAt(row, "advertiser_id") === advertiserID,
  );
  if (!authorizedAccount) {
    throw new Error(`TikTok advertiser ${advertiserID} is not authorized for the configured app.`);
  }
  const info = await tiktokGet(
    "advertiser/info/",
    new URLSearchParams({
      advertiser_ids: JSON.stringify([advertiserID]),
      fields: JSON.stringify(["name", "currency", "timezone"]),
    }),
    stringAt(credential, "access_token"),
  );
  const account = objectsAt(info, "data.list")[0] ?? {};
  return {
    id: advertiserID,
    name:
      nullableStringAt(account, "name") ||
      nullableStringAt(authorizedAccount, "advertiser_name") ||
      nullableStringAt(credential, "advertiser_name"),
    currency: nullableStringAt(account, "currency"),
    timezone: nullableStringAt(account, "timezone"),
  };
}

async function tiktokCampaigns(credential: JsonObject): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const body = await tiktokGet(
      "campaign/get/",
      new URLSearchParams({
        advertiser_id: stringAt(credential, "advertiser_id"),
        fields: JSON.stringify([
          "campaign_id",
          "campaign_name",
          "operation_status",
          "secondary_status",
          "objective_type",
        ]),
        page: String(page),
        page_size: "1000",
      }),
      stringAt(credential, "access_token"),
    );
    rows.push(...objectsAt(body, "data.list"));
    totalPages = Math.max(1, numberAt(body, "data.page_info.total_page"));
    page += 1;
  } while (page <= totalPages);
  return rows;
}

async function tiktokReport(
  credential: JsonObject,
  range: { from: string; to: string },
): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const body = await tiktokGet(
      "report/integrated/get/",
      new URLSearchParams({
        advertiser_id: stringAt(credential, "advertiser_id"),
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify([
          "impressions",
          "clicks",
          "spend",
          "conversion",
          "real_time_conversion",
        ]),
        start_date: range.from,
        end_date: range.to,
        page: String(page),
        page_size: "1000",
      }),
      stringAt(credential, "access_token"),
    );
    rows.push(...objectsAt(body, "data.list"));
    totalPages = Math.max(1, numberAt(body, "data.page_info.total_page"));
    page += 1;
  } while (page <= totalPages);
  return rows;
}

async function tiktokGet(
  path: string,
  query: URLSearchParams,
  accessToken: string,
): Promise<JsonObject> {
  const response = await fetch(`https://business-api.tiktok.com/open_api/v1.3/${path}?${query}`, {
    headers: { "Access-Token": accessToken },
  });
  const body = await jsonResponse(response);
  if (!response.ok || numberAt(body, "code") !== 0) {
    throw apiError("TikTok Ads", response, body);
  }
  return asObject(body);
}

async function safeAccess(
  platform: AdPlatform,
  configured: boolean,
  load: () => Promise<AdAccount>,
): Promise<AdAccess> {
  if (!configured) {
    return {
      platform,
      platformName: PLATFORM_NAMES[platform],
      state: "unavailable",
      configured: false,
      account: null,
      message: `${PLATFORM_NAMES[platform]} credentials are not configured.`,
      checkedAt: now(),
    };
  }
  try {
    return readyAccess(platform, await load());
  } catch (error) {
    return errorAccess(platform, configured, error);
  }
}

function readyAccess(platform: AdPlatform, account: AdAccount): AdAccess {
  return {
    platform,
    platformName: PLATFORM_NAMES[platform],
    state: "ready",
    configured: true,
    account,
    message: null,
    checkedAt: now(),
  };
}

function ensureMappedAccount(account: AdAccount, mapping?: AdsProjectPlatform): AdAccount {
  if (mapping?.accountIds.length && !mapping.accountIds.includes(account.id)) {
    throw new Error(
      `Configured account ${account.id} is not mapped to the selected advertising project.`,
    );
  }
  return account;
}

function errorAccess(platform: AdPlatform, configured: boolean, error: unknown): AdAccess {
  return {
    platform,
    platformName: PLATFORM_NAMES[platform],
    state: "error",
    configured,
    account: null,
    message: sanitizeError(errorMessage(error)),
    checkedAt: now(),
  };
}

function readyStats(
  platform: AdPlatform,
  account: AdAccount,
  period: AdsPeriod,
  range: { from: string; to: string },
  input: {
    attribution: string;
    impressions: number;
    clicks: number;
    spend: number;
    nativeConversions: NativeMetric[];
    checkedAt: string;
    daily: DailyStats[];
    providerUpdatedAt?: string | null;
    freshnessNote: string;
  },
): PlatformStats {
  return {
    ...readyAccess(platform, account),
    checkedAt: input.checkedAt,
    period,
    range,
    attribution: input.attribution,
    freshness: {
      fetchedAt: input.checkedAt,
      providerUpdatedAt: input.providerUpdatedAt ?? null,
      note: input.freshnessNote,
    },
    metrics: {
      impressions: round(input.impressions),
      clicks: round(input.clicks),
      spend: round(input.spend),
      nativeConversions: input.nativeConversions.filter((metric) => metric.value !== 0),
    },
    daily: input.daily,
  };
}

function emptyStats(access: AdAccess, period: AdsPeriod): PlatformStats {
  return {
    ...access,
    period,
    range: null,
    attribution: null,
    freshness: { fetchedAt: access.checkedAt, providerUpdatedAt: null, note: null },
    metrics: null,
    daily: [],
  };
}

function groupedDailyStats(
  rows: JsonObject[],
  range: { from: string; to: string },
  fields: {
    date: string;
    impressions: string;
    clicks: string;
    spend(row: JsonObject): number;
    conversions: Array<[string, string]>;
  },
): DailyStats[] {
  const grouped = new Map<string, DailyStats>();
  for (const row of rows) {
    const date = stringAt(row, fields.date);
    if (!date) continue;
    const current = grouped.get(date) ?? {
      date,
      impressions: 0,
      clicks: 0,
      spend: 0,
      nativeConversions: [],
    };
    current.impressions += numberAt(row, fields.impressions);
    current.clicks += numberAt(row, fields.clicks);
    current.spend += fields.spend(row);
    current.nativeConversions = mergeNativeMetrics([
      ...current.nativeConversions,
      ...fields.conversions.map(([path, name]) => ({ name, value: numberAt(row, path) })),
    ]);
    grouped.set(date, current);
  }
  return fillDailyRange([...grouped.values()], range);
}

function fillDailyRange(rows: DailyStats[], range: { from: string; to: string }): DailyStats[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return datesInRange(range).map((date) => {
    const row = byDate.get(date);
    return row
      ? {
          ...row,
          impressions: round(row.impressions),
          clicks: round(row.clicks),
          spend: round(row.spend),
          nativeConversions: row.nativeConversions.filter(({ value }) => value !== 0),
        }
      : { date, impressions: 0, clicks: 0, spend: 0, nativeConversions: [] };
  });
}

function datesInRange(range: { from: string; to: string }): string[] {
  const dates: string[] = [];
  let date = range.from;
  while (date <= range.to) {
    dates.push(date);
    date = nextDate(date);
  }
  return dates;
}

function mergeNativeMetrics(metrics: NativeMetric[]): NativeMetric[] {
  const totals = new Map<string, number>();
  for (const metric of metrics) {
    totals.set(metric.name, (totals.get(metric.name) ?? 0) + metric.value);
  }
  return [...totals].map(([name, value]) => ({ name, value: round(value) }));
}

function reportingRange(period: AdsPeriod, timezone: string | null): { from: string; to: string } {
  const days = period === "7d" ? 7 : 30;
  const today = dateInTimezone(new Date(), timezone || "UTC");
  const to = previousDate(today, 1);
  return { from: previousDate(to, days - 1), to };
}

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function nextDate(date: string): string {
  return previousDate(date, -1);
}

export function zonedMidnightIso(date: string, timezone: string | null): string {
  if (!timezone) return `${date}T00:00:00.000Z`;
  const desired = Date.parse(`${date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let target = desired;

  // Treat the formatted local time as a UTC value and iteratively remove the
  // timezone offset. This remains correct when the offset changes at midnight
  // (for example, on a DST transition).
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const values = Object.fromEntries(
      formatter
        .formatToParts(new Date(target))
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, Number(value)]),
    );
    const shown = Date.UTC(
      values.year,
      values.month - 1,
      values.day,
      values.hour,
      values.minute,
      values.second,
    );
    const delta = desired - shown;
    target += delta;
    if (delta === 0) break;
  }
  return new Date(target).toISOString();
}

async function secretEnvironment(): Promise<Record<string, string>> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  try {
    const contents = await readFile(join(CREDENTIALS_ROOT, "secrets.zsh"), "utf8");
    for (const line of contents.split("\n")) {
      const match = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
      if (!match || env[match[1]]) continue;
      env[match[1]] = shellValue(match[2]);
    }
  } catch {
    // Missing secrets are reported by the provider-specific required-field check.
  }
  return env;
}

function shellValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function credentialExists(relativePath: string): Promise<boolean> {
  try {
    await readFile(credentialPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readCredential(relativePath: string): Promise<JsonObject> {
  try {
    return asObject(JSON.parse(await readFile(credentialPath(relativePath), "utf8")));
  } catch (error) {
    throw new Error(`Cannot read ${relativePath}: ${errorMessage(error)}`);
  }
}

function credentialPath(relativePath: string): string {
  return join(CREDENTIALS_ROOT, relativePath);
}

async function atomicPrivateJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function cachedDocument<T extends { cached: boolean; generatedAt: string }>(
  key: string,
  refresh: boolean,
  load: () => Promise<T>,
): Promise<T> {
  const path = join(CACHE_ROOT, `${key}.json`);
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(path, "utf8")) as T;
      if (Date.now() - Date.parse(cached.generatedAt) < CACHE_TTL_MS) {
        return { ...cached, cached: true };
      }
    } catch {
      // Invalid and expired cache entries are replaced by a fresh provider read.
    }
  }
  const document = await load();
  await atomicPrivateJSON(path, document);
  return document;
}

async function jsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function apiError(label: string, response: Response, body: unknown): Error {
  const object = Array.isArray(body) ? asObject(body[0]) : asObject(body);
  const nestedError = asObject(object.error);
  const errors = Array.isArray(object.errors) ? object.errors.map(asObject) : [];
  const message =
    nullableStringAt(nestedError, "message") ||
    nullableStringAt(object, "debug_message") ||
    nullableStringAt(object, "display_message") ||
    nullableStringAt(object, "message") ||
    nullableStringAt(object, "request_status") ||
    errors
      .map((error) => nullableStringAt(error, "message") || nullableStringAt(error, "code"))
      .filter(Boolean)
      .join(", ") ||
    "unknown error";
  const code =
    nullableStringAt(nestedError, "code") ||
    nullableStringAt(object, "code") ||
    errors
      .map((error) => nullableStringAt(error, "code"))
      .filter(Boolean)
      .join(", ");
  return new Error(
    `${label} request failed (${response.status})${code ? ` ${code}` : ""}: ${message}`,
  );
}

function nativeMetrics(rows: JsonObject[], fields: Array<[string, string]>): NativeMetric[] {
  return fields.map(([path, name]) => ({ name, value: round(sum(rows, path)) }));
}

function sum(rows: JsonObject[], path: string): number {
  return rows.reduce((total, row) => total + numberAt(row, path), 0);
}

function objectsAt(value: unknown, path: string): JsonObject[] {
  const found = valueAt(value, path);
  return Array.isArray(found) ? found.map(asObject) : [];
}

function numberAt(value: unknown, path: string): number {
  return numberValue(valueAt(value, path));
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function stringAt(value: unknown, path: string): string {
  return nullableStringAt(value, path) || "";
}

function nullableStringAt(value: unknown, path: string): string | null {
  const found = valueAt(value, path);
  if (found === null || found === undefined) return null;
  return String(found);
}

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (Array.isArray(current)) return current[Number(part)];
    if (!current || typeof current !== "object") return undefined;
    return (current as JsonObject)[part];
  }, value);
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeError(message: string): string {
  return message
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .slice(0, 1_000);
}
