import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  cleanLaravelS3Bucket,
  cleanLaravelS3Prefix,
  deleteLaravelS3Bucket,
  ensureLaravelS3Bucket,
  cleanTestingDatabases,
  ensureLaravelAppKey,
  setupDatabase,
  verifyLaravelS3Bucket,
  verifyDatabase,
} from "./resources";
import type { ProjectEnvironmentContext } from "./types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

test("cleans only the lane-owned Laravel parallel testing database family", () => {
  const root = mkdtempSync(resolve(tmpdir(), "project-environment-resources-"));
  temporaryDirectories.push(root);
  const log = resolve(root, "mysql.log");
  const mysql = resolve(root, "mysql");
  writeFileSync(
    mysql,
    `#!/bin/sh
case "$*" in
  *"SELECT SCHEMA_NAME"*)
    printf '%s\\n' example_lane_3_testing example_lane_3_agent example_lane_3_mutation example_lane_3_testing_test_1 example_lane_3_testing_test_8
    ;;
  *)
    printf '%s\\n' "$*" >> '${log}'
    ;;
esac
`,
  );
  chmodSync(mysql, 0o755);
  const context = {
    root,
    lane: "lane-3",
    testingDatabase: "example_lane_3_testing",
    agentDatabase: "example_lane_3_agent",
    mutationDatabase: "example_lane_3_mutation",
    mysqlCommand: mysql,
    herdBin: root,
  } as ProjectEnvironmentContext;

  cleanTestingDatabases(context);

  const commands = readFileSync(log, "utf8");
  expect(commands).toContain("DROP DATABASE IF EXISTS `example_lane_3_testing`");
  expect(commands).toContain("DROP DATABASE IF EXISTS `example_lane_3_agent`");
  expect(commands).toContain("DROP DATABASE IF EXISTS `example_lane_3_mutation`");
  expect(commands).toContain("DROP DATABASE IF EXISTS `example_lane_3_testing_test_1`");
  expect(commands).toContain("DROP DATABASE IF EXISTS `example_lane_3_testing_test_8`");
  expect(commands).not.toContain("example_lane_2");
});

test("creates and verifies every lane-owned database role", () => {
  const root = mkdtempSync(resolve(tmpdir(), "project-environment-databases-"));
  temporaryDirectories.push(root);
  const log = resolve(root, "mysql.log");
  const mysql = resolve(root, "mysql");
  writeFileSync(
    mysql,
    `#!/bin/sh
printf '%s\n' "$*" >> '${log}'
case "$*" in
  *"SELECT SCHEMA_NAME"*)
    printf '%s\n' example_lane_3 example_lane_3_agent example_lane_3_mutation example_lane_3_testing
    ;;
esac
`,
  );
  chmodSync(mysql, 0o755);
  const context = {
    root,
    database: "example_lane_3",
    testingDatabase: "example_lane_3_testing",
    agentDatabase: "example_lane_3_agent",
    mutationDatabase: "example_lane_3_mutation",
    mysqlCommand: mysql,
    herdBin: root,
  } as ProjectEnvironmentContext;

  setupDatabase(context);
  verifyDatabase(context);

  const commands = readFileSync(log, "utf8");
  for (const database of [
    "example_lane_3",
    "example_lane_3_testing",
    "example_lane_3_agent",
    "example_lane_3_mutation",
  ]) {
    expect(commands).toContain(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    expect(commands).toContain(`'${database}'`);
  }
});

test("keeps the centrally managed Laravel testing application key", () => {
  const root = mkdtempSync(resolve(tmpdir(), "project-environment-app-key-"));
  temporaryDirectories.push(root);
  const backendDir = resolve(root, "app");
  mkdirSync(backendDir, { recursive: true });
  writeFileSync(resolve(backendDir, ".env"), "APP_KEY=base64:lane-key\n");
  writeFileSync(resolve(backendDir, ".env.testing"), "APP_KEY=base64:test-key\n");

  ensureLaravelAppKey({ backendDir } as ProjectEnvironmentContext);

  expect(readFileSync(resolve(backendDir, ".env.testing"), "utf8")).toContain(
    "APP_KEY=base64:test-key",
  );
});

test("rejects broad or unsafe S3 cleanup prefixes before invoking Laravel", () => {
  expect(() => cleanLaravelS3Prefix({} as ProjectEnvironmentContext, "/")).toThrow(
    "Unsafe S3 cleanup prefix",
  );
  expect(() => cleanLaravelS3Prefix({} as ProjectEnvironmentContext, "../other-lane")).toThrow(
    "Unsafe S3 cleanup prefix",
  );
});

test("scopes full S3 cleanup to the configured lane bucket", () => {
  const root = mkdtempSync(resolve(tmpdir(), "project-environment-storage-"));
  temporaryDirectories.push(root);
  const log = resolve(root, "php.log");
  const php = resolve(root, "php");
  writeFileSync(php, `#!/bin/sh\nprintf '%s\\n' "$*" > '${log}'\n`);
  chmodSync(php, 0o755);

  cleanLaravelS3Bucket({
    root,
    backendDir: root,
    bucket: "example-lane-3",
    phpCommand: php,
    phpArgsPrefix: [],
  } as unknown as ProjectEnvironmentContext);

  const command = readFileSync(log, "utf8");
  expect(command).toContain('$expectedBucket = "example-lane-3"');
  expect(command).toContain("does not belong to this lane");
  expect(command).toContain("$disk->allFiles()");
});

test("manages a private lane-owned S3 bucket through its Laravel disk", () => {
  const root = mkdtempSync(resolve(tmpdir(), "project-environment-private-storage-"));
  temporaryDirectories.push(root);
  const log = resolve(root, "php.log");
  const php = resolve(root, "php");
  writeFileSync(php, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(php, 0o755);
  const context = {
    root,
    backendDir: root,
    bucket: "example-lane-3",
    phpCommand: php,
    phpArgsPrefix: [],
  } as unknown as ProjectEnvironmentContext;
  const target = {
    disk: "attachments",
    bucket: "example-lane-3-private",
  };

  ensureLaravelS3Bucket(context, { ...target, publicRead: false });
  verifyLaravelS3Bucket(context, { ...target, publicRead: false });
  cleanLaravelS3Bucket(context, target);
  deleteLaravelS3Bucket(context, target);

  const commands = readFileSync(log, "utf8");
  expect(commands).toContain('Storage::disk("attachments")');
  expect(commands).toContain("config('filesystems.disks.attachments.bucket')");
  expect(commands).toContain('$expectedBucket = "example-lane-3-private"');
  expect(commands).toContain("deleteBucketPolicy");
  expect(commands).toContain("Private S3 bucket [{$bucket}] has a bucket policy");
  expect(commands).toContain("$client->deleteBucket(['Bucket' => $bucket])");
});

test("rejects an S3 bucket outside the lane namespace", () => {
  const context = { bucket: "example-lane-3" } as ProjectEnvironmentContext;

  expect(() =>
    ensureLaravelS3Bucket(context, { disk: "attachments", bucket: "another-lane-private" }),
  ).toThrow("is not owned by lane example-lane-3");
});
