#!/usr/bin/env bun

import { join } from "node:path";

import { assertCentralizedModels } from "../lib/models";

assertCentralizedModels(join(import.meta.dir, "..", ".."));
console.log("Model catalog references valid");
