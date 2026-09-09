import { getProjectEnvironmentDefinition } from "../../../../config/active-projects";

import * as runtime from "../runtime";
import type { ProjectEnvironmentAdapter, ProjectEnvironmentContext } from "../types";

interface HariumContext extends ProjectEnvironmentContext {
  attachmentsBucket: string;
  typesense: { url: string; apiKey: string };
}

const backendSecretKeys = ["MAIL_PASSWORD", "EXPO_ACCESS_TOKEN", "OPENAI_API_KEY"];

const expoEnvironmentOptions = {
  apiUrlKeys: ["EXPO_PUBLIC_LOCAL_APP_URL", "EXPO_PUBLIC_APP_URL"],
  metroPortKeys: ["EXPO_DEV_SERVER_PORT"],
  simulatorNameKey: "EXPO_IOS_SIMULATOR",
};

function expoEnvironment(value: HariumContext) {
  return {
    ...expoEnvironmentOptions,
    values: { EXPO_PUBLIC_ANDROID_APP_URL: `http://10.0.2.2:${19300 + value.laneNumber}` },
  };
}

function context(): HariumContext {
  const value = runtime.createProjectEnvironmentContext(getProjectEnvironmentDefinition("harium"));
  return {
    ...value,
    attachmentsBucket: `${value.bucket}-private`,
    typesense: { url: "http://127.0.0.1:8108", apiKey: "LARAVEL-HERD" },
  };
}

function backendEnvironmentValues(value: HariumContext): Record<string, string> {
  return {
    APP_ENV: "local",
    SERVER_PORT: String(19300 + value.laneNumber),
    DB_CONNECTION: "mysql",
    SESSION_DRIVER: "file",
    SESSION_SECURE_COOKIE: "true",
    CACHE_STORE: "file",
    CACHE_PREFIX: `${value.prefix}_cache_`,
    QUEUE_CONNECTION: "redis",
    REDIS_PREFIX: `${value.prefix}_redis_`,
    REDIS_QUEUE: value.prefix,
    SCOUT_PREFIX: `${value.prefix}_`,
    TYPESENSE_HOST: "127.0.0.1",
    TYPESENSE_PORT: "8108",
    TYPESENSE_PROTOCOL: "http",
    TYPESENSE_API_KEY: value.typesense.apiKey,
    FILESYSTEM_DISK: "s3",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_THROW: "true",
    AWS_REPORT: "true",
    AWS_ATTACHMENTS_BUCKET: value.attachmentsBucket,
    R2_ASSETS_URL: value.assetUrl!,
    MAIL_MAILER: "log",
    MAIL_FROM_ADDRESS: `${value.prefix}@harium.test`,
    HARIUM_AI_MODEL: "gpt-5.6-luna",
    HARIUM_AI_REASONING_EFFORT: "medium",
    HARIUM_AI_PROMPT_VERSION: "2026-08-15",
  };
}

function setupApplicationData(value: ProjectEnvironmentContext): void {
  const userCount = Number(
    runtime
      .artisanOutput(value, "seed", ["tinker", "--execute", "echo App\\Models\\User::count();"])
      .trim(),
  );
  if (userCount === 0) runtime.artisan(value, "seed", ["db:seed", "--force"]);
  else runtime.artisan(value, "storage", ["character:sync", "--yes"]);
}

function verifyApplicationData(value: ProjectEnvironmentContext): string {
  const state = runtime.artisanOutput(value, "verify:data", [
    "tinker",
    "--execute",
    "echo json_encode(['users' => App\\Models\\User::count(), 'parts' => App\\Models\\CharacterPart::count(), 'objects' => Illuminate\\Support\\Facades\\Storage::disk('s3')->allFiles('character-parts')]);",
  ]);
  const parsed = JSON.parse(state.slice(state.indexOf("{"))) as {
    users: number;
    parts: number;
    objects: string[];
  };
  if (parsed.users < 2 || parsed.parts < 1 || parsed.objects.length < 1) {
    throw new Error("Seeded users or character assets are missing");
  }
  return parsed.objects[0];
}

function operationContext(): {
  value: HariumContext;
  laravelEnvironment: { secretKeys: string[]; values: Record<string, string> };
} {
  const value = context();
  return {
    value,
    laravelEnvironment: {
      secretKeys: backendSecretKeys,
      values: backendEnvironmentValues(value),
    },
  };
}

async function setup(): Promise<void> {
  const { value, laravelEnvironment } = operationContext();
  runtime.trustMise(value);
  runtime.setupHerd(value);
  runtime.setupLaravelEnvironment(value, laravelEnvironment);
  runtime.setupExpoEnvironment(value, expoEnvironment(value));
  runtime.setupDatabase(value);
  runtime.ensureComposerDependencies(value, {
    installArgs: ["install", "--no-interaction", "--prefer-dist"],
  });
  runtime.ensureBunDependencies(value, {
    label: "backend Bun dependencies",
    directory: value.backendDir,
  });
  runtime.run(value, "backend-build", "bun", ["run", "build"], {
    cwd: value.backendDir,
  });
  runtime.ensureLaravelAppKey(value);
  runtime.artisan(value, "cache", ["config:clear"]);
  runtime.artisan(value, "migrations", ["migrate", "--force"]);
  runtime.artisan(value, "cache", ["optimize:clear"]);
  runtime.ensureLaravelS3Bucket(value, { publicRead: true });
  runtime.ensureLaravelS3Bucket(value, {
    disk: "attachments",
    bucket: value.attachmentsBucket,
    publicRead: false,
  });
  setupApplicationData(value);
  runtime.log("setup", `ready: ${value.appUrl}`);
}

async function mobileDevelopment(): Promise<void> {
  const value = context();
  runtime.ensureBunDependencies(value, {
    label: "mobile Bun dependencies",
    directory: value.mobileDir,
  });
  runtime.setupExpoEnvironment(value, expoEnvironment(value));
  runtime.setupSimulator(value);
  runtime.log("mobile", `Metro ${value.metroPort} | simulator ${value.simulatorName}`);
}

async function verify(args: string[]): Promise<void> {
  const { value, laravelEnvironment } = operationContext();
  runtime.verifyLaneInfrastructure(value);
  runtime.verifyLaravelEnvironment(value, laravelEnvironment);
  runtime.verifyExpoEnvironmentFile(value, expoEnvironment(value));
  runtime.verifyLaravelS3Bucket(value);
  runtime.verifyLaravelS3Bucket(value, {
    disk: "attachments",
    bucket: value.attachmentsBucket,
    publicRead: false,
  });
  await runtime.verifyTypesense(value.typesense);
  const object = verifyApplicationData(value);
  await runtime.verifyFetch(value.appUrl, "Herd HTTPS site", {}, value.herdCertificateAuthority);
  await runtime.verifyFetch(`${value.assetUrl}/${object}`, "seeded asset");
  if (args.includes("--mobile-development")) {
    runtime.verifySimulator(value);
    await runtime.verifyExpoDevelopmentServer(value.metroPort);
  }
  runtime.log("verify", "passed");
}

async function reset(): Promise<void> {
  const value = context();
  runtime.cleanTestingDatabases(value);
  runtime.setupDatabase(value);
  await runtime.deleteTypesenseCollections(value.typesense, `${value.prefix}_`);
  runtime.cleanLaravelS3Bucket(value);
  runtime.cleanLaravelS3Bucket(value, {
    disk: "attachments",
    bucket: value.attachmentsBucket,
  });
  runtime.artisan(value, "reset-database", ["migrate:fresh", "--seed", "--force"]);
  runtime.log("reset", `${value.lane} is reset`);
}

async function destroy(): Promise<void> {
  const value = context();
  runtime.deleteLaravelS3Bucket(value, { allowFailure: true });
  runtime.deleteLaravelS3Bucket(value, {
    disk: "attachments",
    bucket: value.attachmentsBucket,
    allowFailure: true,
  });
  await runtime.deleteTypesenseCollections(value.typesense, `${value.prefix}_`, {
    allowFailure: true,
  });
  runtime.cleanDatabase(value);
  runtime.cleanHerd(value);
  runtime.cleanSimulator(value);
  runtime.removeProjectEnvironmentFiles(value);
  runtime.log("destroy", `removed resources owned by ${value.lane}`);
}

export const adapter: ProjectEnvironmentAdapter = {
  databaseRoles: [],
  operations: {
    setup,
    "mobile-development": mobileDevelopment,
    verify,
    reset,
    destroy,
  },
};
