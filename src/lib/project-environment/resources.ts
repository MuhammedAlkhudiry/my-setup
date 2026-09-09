import { existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { output, run } from "./command";
import type { ProjectEnvironmentContext } from "./types";

export function artisan(context: ProjectEnvironmentContext, step: string, args: string[]): void {
  run(context, step, context.phpCommand, [...context.phpArgsPrefix, "artisan", ...args], {
    cwd: context.backendDir,
  });
}

export function artisanOutput(
  context: ProjectEnvironmentContext,
  step: string,
  args: string[],
): string {
  return output(context, step, context.phpCommand, [...context.phpArgsPrefix, "artisan", ...args], {
    cwd: context.backendDir,
  });
}

export function ensureLaravelAppKey(context: ProjectEnvironmentContext): void {
  const envPath = resolve(context.backendDir, ".env");
  if (!/^APP_KEY=base64:.+/m.test(readFileSync(envPath, "utf8"))) {
    artisan(context, "app-key", ["key:generate", "--force"]);
  }
  if (!/^APP_KEY=base64:.+/m.test(readFileSync(envPath, "utf8"))) {
    throw new Error(`Laravel APP_KEY was not generated in ${envPath}`);
  }
}

export function reindexLaravelScoutModels(context: ProjectEnvironmentContext): void {
  const script = [
    "config(['scout.queue' => false]);",
    "$models = collect(Illuminate\\Support\\Facades\\File::allFiles(app_path('Models')))",
    "    ->map(function ($file) {",
    "        $relative = str_replace(DIRECTORY_SEPARATOR, '\\\\', $file->getRelativePath());",
    "        return app()->getNamespace().'Models\\\\'.($relative ? $relative.'\\\\' : '').$file->getFilenameWithoutExtension();",
    "    })",
    "    ->filter(fn ($model) => class_exists($model)",
    "        && is_subclass_of($model, Illuminate\\Database\\Eloquent\\Model::class)",
    "        && ! (new ReflectionClass($model))->isAbstract()",
    "        && in_array(Laravel\\Scout\\Searchable::class, class_uses_recursive($model), true));",
    "foreach ($models as $model) {",
    '    echo "Importing {$model}\\n";',
    "    $model::makeAllSearchable();",
    "}",
  ].join("\n");
  artisan(context, "search", ["tinker", "--execute", script]);
}

interface LaravelS3BucketTarget {
  disk?: string;
  bucket?: string;
}

function laravelS3BucketPrelude(
  context: ProjectEnvironmentContext,
  options: LaravelS3BucketTarget = {},
): string[] {
  const disk = options.disk ?? "s3";
  const bucket = options.bucket ?? context.bucket;
  if (!/^[a-zA-Z0-9_-]+$/.test(disk)) throw new Error(`Unsafe Laravel S3 disk: ${disk}`);
  if (bucket !== context.bucket && !bucket.startsWith(`${context.bucket}-`)) {
    throw new Error(`S3 bucket ${bucket} is not owned by lane ${context.bucket}`);
  }
  const encodedDisk = JSON.stringify(disk);
  const expectedBucket = JSON.stringify(bucket);
  return [
    `$disk = Storage::disk(${encodedDisk});`,
    "$client = $disk->getClient();",
    `$bucket = config('filesystems.disks.${disk}.bucket');`,
    `$expectedBucket = ${expectedBucket};`,
    'if ($bucket !== $expectedBucket) { throw new RuntimeException("Configured S3 bucket [{$bucket}] does not belong to this lane."); }',
  ];
}

export function ensureLaravelS3Bucket(
  context: ProjectEnvironmentContext,
  options: LaravelS3BucketTarget & { publicRead?: boolean } = {},
): void {
  const policy =
    options.publicRead === true
      ? "$client->putBucketPolicy(['Bucket' => $bucket, 'Policy' => json_encode(['Version' => '2012-10-17', 'Statement' => [['Effect' => 'Allow', 'Principal' => '*', 'Action' => ['s3:GetObject'], 'Resource' => [\"arn:aws:s3:::{$bucket}/*\"]]]], JSON_THROW_ON_ERROR)]);"
      : options.publicRead === false
        ? "$client->deleteBucketPolicy(['Bucket' => $bucket]);"
        : "";
  artisan(context, "storage", [
    "tinker",
    "--execute",
    [
      ...laravelS3BucketPrelude(context, options),
      "try { $client->headBucket(['Bucket' => $bucket]); } catch (Throwable $exception) { $client->createBucket(['Bucket' => $bucket]); }",
      policy,
    ].join(" "),
  ]);
}

export function verifyLaravelS3Bucket(
  context: ProjectEnvironmentContext,
  options: LaravelS3BucketTarget & { publicRead?: boolean } = {},
): void {
  const privacyCheck =
    options.publicRead === false
      ? "try { $client->getBucketPolicy(['Bucket' => $bucket]); throw new RuntimeException(\"Private S3 bucket [{$bucket}] has a bucket policy.\"); } catch (Aws\\S3\\Exception\\S3Exception $exception) { if ($exception->getAwsErrorCode() !== 'NoSuchBucketPolicy') { throw $exception; } }"
      : "";
  artisan(context, "verify:storage", [
    "tinker",
    "--execute",
    [
      ...laravelS3BucketPrelude(context, options),
      "$client->headBucket(['Bucket' => $bucket]);",
      "$client->listObjectsV2(['Bucket' => $bucket, 'MaxKeys' => 1]);",
      privacyCheck,
    ].join(" "),
  ]);
}

export function cleanLaravelS3Prefix(
  context: ProjectEnvironmentContext,
  prefix: string,
  options: LaravelS3BucketTarget = {},
): void {
  if (!prefix || !/^[a-zA-Z0-9_/-]+$/.test(prefix) || prefix.startsWith("/")) {
    throw new Error(`Unsafe S3 cleanup prefix: ${prefix}`);
  }
  const encodedPrefix = JSON.stringify(prefix);
  artisan(context, "clean:storage", [
    "tinker",
    "--execute",
    [
      ...laravelS3BucketPrelude(context, options),
      `$files = $disk->allFiles(${encodedPrefix});`,
      "foreach (array_chunk($files, 1000) as $chunk) { $disk->delete($chunk); }",
    ].join(" "),
  ]);
}

export function cleanLaravelS3Bucket(
  context: ProjectEnvironmentContext,
  options: LaravelS3BucketTarget = {},
): void {
  artisan(context, "clean:storage", [
    "tinker",
    "--execute",
    [
      ...laravelS3BucketPrelude(context, options),
      "$files = $disk->allFiles();",
      "foreach (array_chunk($files, 1000) as $chunk) { $disk->delete($chunk); }",
    ].join(" "),
  ]);
}

export function deleteLaravelS3Bucket(
  context: ProjectEnvironmentContext,
  options: LaravelS3BucketTarget & { allowFailure?: boolean } = {},
): void {
  run(
    context,
    "clean:storage",
    context.phpCommand,
    [
      ...context.phpArgsPrefix,
      "artisan",
      "tinker",
      "--execute",
      [
        ...laravelS3BucketPrelude(context, options),
        "if ($client->doesBucketExistV2($bucket)) {",
        "foreach (array_chunk($disk->allFiles(), 1000) as $chunk) { $disk->delete($chunk); }",
        "$client->deleteBucket(['Bucket' => $bucket]);",
        "}",
      ].join(" "),
    ],
    { cwd: context.backendDir, allowFailure: options.allowFailure },
  );
}

export function trustMise(context: ProjectEnvironmentContext): void {
  if (!existsSync(resolve(context.root, "mise.toml"))) return;
  run(context, "mise", "mise", ["trust", context.root], { cwd: context.root });
}

export function setupHerd(context: ProjectEnvironmentContext): void {
  const current = herdSite(context);
  if (!current || resolve(current.path) !== context.backendDir) {
    if (current) {
      run(context, "herd", context.herdCommand, ["unlink", context.site], {
        cwd: context.backendDir,
        allowFailure: true,
      });
    }
    run(context, "herd", context.herdCommand, ["link", context.site], {
      cwd: context.backendDir,
    });
  }
  const sitePath = herdSitePath(context);
  const target = resolve(dirname(sitePath), readlinkSync(sitePath));
  if (target !== context.backendDir) {
    unlinkSync(sitePath);
    symlinkSync(context.backendDir, sitePath, "dir");
  }
  const linked = herdSite(context);
  if (!linked?.secured || !existsSync(context.herdCertificate) || !existsSync(context.herdKey)) {
    run(context, "herd", context.herdCommand, ["secure", context.site, "--no-interaction"], {
      cwd: context.backendDir,
    });
  }
  verifyHerdCertificateFiles(context);
  if (herdSite(context)?.phpVersion !== context.phpVersion) {
    run(
      context,
      "herd",
      context.herdCommand,
      ["isolate", context.phpVersion, `--site=${context.site}`],
      { cwd: context.backendDir },
    );
  }
}

export function verifyHerd(context: ProjectEnvironmentContext): void {
  const site = herdSite(context, "verify:herd");
  if (!site) throw new Error(`Herd site ${context.site} is missing`);
  if (!site.secured) throw new Error(`Herd site ${context.site} is not secured`);
  if (site.phpVersion !== context.phpVersion) {
    throw new Error(
      `Herd site ${context.site} uses PHP ${site.phpVersion}, not ${context.phpVersion}`,
    );
  }

  const sitePath = herdSitePath(context);
  const target = resolve(dirname(sitePath), readlinkSync(sitePath));
  if (target !== context.backendDir) {
    throw new Error(`Herd site ${context.site} points to ${target}, not ${context.backendDir}`);
  }
  verifyHerdCertificateFiles(context);
}

function herdSite(
  context: ProjectEnvironmentContext,
  step = "herd:inspect",
): { site: string; path: string; secured: boolean; phpVersion: string } | undefined {
  const document: unknown = JSON.parse(
    output(context, step, context.herdCommand, ["sites", "--json"], {
      cwd: context.root,
    }),
  );
  const sites = z
    .array(
      z.object({
        site: z.string(),
        path: z.string(),
        secured: z.boolean(),
        phpVersion: z.string(),
      }),
    )
    .parse(document);
  return sites.find(({ site }) => site === context.site) ?? linkedHerdSite(context, step);
}

function linkedHerdSite(
  context: ProjectEnvironmentContext,
  step: string,
): { site: string; path: string; secured: boolean; phpVersion: string } | undefined {
  const sitePath = herdSitePath(context);
  if (!existsSync(sitePath)) return undefined;

  let path: string;
  try {
    path = resolve(dirname(sitePath), readlinkSync(sitePath));
  } catch {
    return undefined;
  }

  const phpCommand = output(
    context,
    `${step}:php`,
    context.herdCommand,
    ["which-php", context.site],
    { cwd: context.root },
  ).trim();
  const phpVersion = output(
    context,
    `${step}:php-version`,
    phpCommand,
    ["-r", "echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION;"],
    { cwd: context.root },
  ).trim();

  return {
    site: context.site,
    path,
    secured: existsSync(context.herdCertificate) && existsSync(context.herdKey),
    phpVersion,
  };
}

function verifyHerdCertificateFiles(context: ProjectEnvironmentContext): void {
  if (!existsSync(context.herdCertificate)) {
    throw new Error(`Herd certificate ${context.herdCertificate} is missing`);
  }
  if (!existsSync(context.herdKey)) {
    throw new Error(`Herd key ${context.herdKey} is missing`);
  }
}

function herdSitePath(context: ProjectEnvironmentContext): string {
  return resolve(homedir(), "Library/Application Support/Herd/config/valet/Sites", context.site);
}

export function cleanHerd(context: ProjectEnvironmentContext): void {
  run(context, "clean:herd", context.herdCommand, ["unlink", context.site], {
    cwd: context.backendDir,
    allowFailure: true,
  });
  for (const path of [
    context.herdCertificate,
    context.herdKey,
    context.herdCertificate.replace(/\.crt$/, ".csr"),
    context.herdCertificate.replace(/\.crt$/, ".conf"),
  ]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

function databaseIdentifier(database: string): string {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error("Unsafe database name");
  return database;
}

function createDatabase(context: ProjectEnvironmentContext, database: string): void {
  const identifier = databaseIdentifier(database);
  run(
    context,
    "database",
    context.mysqlCommand,
    [
      "-h127.0.0.1",
      "-uroot",
      "-e",
      `CREATE DATABASE IF NOT EXISTS \`${identifier}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ],
    { cwd: context.root },
  );
}

export function setupDatabase(context: ProjectEnvironmentContext): void {
  for (const database of projectDatabases(context)) {
    createDatabase(context, database);
  }
}

export function verifyDatabase(context: ProjectEnvironmentContext): void {
  const databases = projectDatabases(context).map(databaseIdentifier);
  const value = output(
    context,
    "verify:database",
    context.mysqlCommand,
    [
      "-h127.0.0.1",
      "-uroot",
      "-Nse",
      `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME IN ('${databases.join("','")}') ORDER BY SCHEMA_NAME`,
    ],
    { cwd: context.root },
  );
  const existing = new Set(value.trim().split(/\s+/).filter(Boolean));
  for (const database of databases) {
    if (!existing.has(database)) throw new Error(`Database ${database} is missing`);
  }
}

function dropDatabase(context: ProjectEnvironmentContext, database: string): void {
  const identifier = databaseIdentifier(database);
  run(
    context,
    "clean:database",
    context.mysqlCommand,
    ["-h127.0.0.1", "-uroot", "-e", `DROP DATABASE IF EXISTS \`${identifier}\``],
    { cwd: context.root },
  );
}

export function cleanTestingDatabases(context: ProjectEnvironmentContext): void {
  const testingDatabase = databaseIdentifier(context.testingDatabase);
  const parallelPrefix = `${testingDatabase}_test_`;
  const exactDatabases = [
    testingDatabase,
    ...(context.agentDatabase ? [databaseIdentifier(context.agentDatabase)] : []),
    ...(context.mutationDatabase ? [databaseIdentifier(context.mutationDatabase)] : []),
  ];
  const value = output(
    context,
    "clean:testing-databases",
    context.mysqlCommand,
    [
      "-h127.0.0.1",
      "-uroot",
      "-Nse",
      `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME IN ('${exactDatabases.join("','")}') OR LEFT(SCHEMA_NAME, ${parallelPrefix.length})='${parallelPrefix}' ORDER BY SCHEMA_NAME`,
    ],
    { cwd: context.root },
  );
  for (const database of value.trim().split(/\s+/).filter(Boolean)) {
    if (!exactDatabases.includes(database) && !database.startsWith(parallelPrefix)) {
      throw new Error(`Database ${database} does not belong to ${context.lane}`);
    }
    dropDatabase(context, database);
  }
}

export function cleanDatabase(context: ProjectEnvironmentContext): void {
  cleanTestingDatabases(context);
  dropDatabase(context, context.database);
}

function projectDatabases(context: ProjectEnvironmentContext): string[] {
  return [
    context.database,
    context.testingDatabase,
    context.agentDatabase,
    context.mutationDatabase,
  ].filter((database): database is string => database !== undefined);
}
