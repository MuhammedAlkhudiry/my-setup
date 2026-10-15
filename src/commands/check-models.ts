#!/usr/bin/env bun

import { agentOutput } from "../lib/agent-output";
import { join } from "node:path";

import { assertCentralizedModels } from "../lib/models";

agentOutput("check-models", { nativeJson: false });

assertCentralizedModels(join(import.meta.dir, "..", ".."));
console.log("Model catalog references valid");
