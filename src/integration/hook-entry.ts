#!/usr/bin/env node
import { recordHookFailure, processHookFromEnvironment, type ClaudeHookInput } from "./hook-processor.js";

async function readStandardInput(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

try {
  const raw = await readStandardInput();
  const input = JSON.parse(raw) as ClaudeHookInput;
  processHookFromEnvironment(input);
} catch (error) {
  // Observation hooks fail open. Persist only the sanitized error, never the raw Hook payload.
  recordHookFailure(error);
  process.exitCode = 0;
}
