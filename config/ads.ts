import { ACTIVE_PROJECTS } from "./active-projects";

export type AdsProjectPlatform = {
  accountIds: readonly string[];
  campaignIds?: readonly string[];
  access?: {
    state: "browser";
    account: {
      id: string;
      name: string;
      currency: string | null;
      timezone: string | null;
    };
    message: string;
  };
};

export type AdsProjectDefinition = {
  id: string;
  name: string;
  classification: "project" | "unassigned";
  platforms: Partial<
    Record<"google" | "meta" | "snapchat" | "tiktok" | "apple", AdsProjectPlatform>
  >;
};

export const ADS_PROJECTS: readonly AdsProjectDefinition[] = ACTIVE_PROJECTS.map(
  ({ id, name }) => ({
    id,
    name,
    classification: "project" as const,
    platforms:
      id === "awraq"
        ? {
            google: {
              accountIds: ["7051243715"],
              campaignIds: ["20327044989", "24029997729"],
            },
            meta: { accountIds: ["2739989222924351"] },
            snapchat: { accountIds: ["6c77a3cc-b84a-4c30-8243-35f05b6f0a8f"] },
            apple: {
              accountIds: ["22534290"],
              campaignIds: ["2144144007"],
              access: {
                state: "browser" as const,
                account: {
                  id: "22534290",
                  name: "Muhammed Alkhudiry",
                  currency: "USD",
                  timezone: "Asia/Riyadh",
                },
                message:
                  "App Store advertising is managed in Apple Ads; API access is intentionally not configured.",
              },
            },
            tiktok: {
              accountIds: ["7665783056824877073"],
              campaignIds: ["1873239047268401"],
            },
          }
        : id === "harium"
          ? {
              google: {
                accountIds: ["1169446096"],
              },
              meta: { accountIds: ["3535706293261316"] },
              tiktok: { accountIds: ["7684018356730658837"] },
              apple: {
                accountIds: ["22534290"],
                access: {
                  state: "browser" as const,
                  account: {
                    id: "22534290",
                    name: "Muhammed Alkhudiry",
                    currency: "USD",
                    timezone: "Asia/Riyadh",
                  },
                  message:
                    "Harium App Store ID 6752504683 is selectable in the shared company Apple Ads account; API access is intentionally not configured.",
                },
              },
            }
          : {},
  }),
);
