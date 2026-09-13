#!/usr/bin/env node
import {
  HookPolicyViolation,
  recordHookFailure,
  processHookFromEnvironment,
  type ClaudeHookInput,
} from "./hook-processor.js";

async function readStandardInput(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

try {
  const raw = await readStandardInput();
  const input = JSON.parse(raw) as ClaudeHookInput;
  const result = processHookFromEnvironment(input);
  if (result.additionalContext) {
    process.stdout.write(JSON.stringify({ additionalContext: result.additionalContext }));
  }
} catch (error) {
  if (error instanceof HookPolicyViolation) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else {
  // Observation hooks fail open. Persist only the sanitized error, never the raw Hook payload.
    recordHookFailure(error);
    process.exitCode = 0;
  }
}
