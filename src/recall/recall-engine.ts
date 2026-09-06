import { EVENT_TYPES } from "../domain/event-types.js";
import type { Stage } from "../domain/lifecycle.js";
import type { ExperienceStore } from "../experiences/experience-store.js";
import type { Experience } from "../experiences/types.js";
import type { HarnessContext } from "../integration/harness-service.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { HarnessSkill } from "../skills/types.js";
import type { EventLedger } from "../storage/event-ledger.js";

export interface RecallRequest {
  taskType: string;
  technologies: string[];
  stage: Stage;
  taskSummary: string;
  errorContext?: string;
  tokenBudget: number;
  disabled?: boolean;
}

export interface RecallItem {
  assetType: "experience" | "skill";
  assetId: string;
  score: number;
  reason: string;
  content: string;
  conflictAssetIds: string[];
}

export interface RecallResult {
  recallEventId: string;
  items: RecallItem[];
  estimatedTokens: number;
  omittedForBudget: number;
  disabled: boolean;
}

export class RecallEngine {
  constructor(
    private readonly ledger: EventLedger,
    private readonly experiences: ExperienceStore,
    private readonly skills: SkillRegistry,
    private readonly runtimeInstanceId: string,
  ) {}

  recall(context: HarnessContext, request: RecallRequest): RecallResult {
    const candidates = request.disabled ? [] : [
      ...this.experiences.list("usable").flatMap((experience) => scoreExperience(experience, request)),
      ...this.skills.listProduction().flatMap((skill) => scoreSkill(skill, request)),
    ].sort((left, right) => right.score - left.score || left.assetId.localeCompare(right.assetId));
    const items: RecallItem[] = [];
    let estimatedTokens = 0;
    for (const candidate of candidates) {
      const cost = estimateTokens(candidate.content);
      if (estimatedTokens + cost > request.tokenBudget) continue;
      items.push(candidate);
      estimatedTokens += cost;
    }
    const event = this.ledger.append({
      eventType: EVENT_TYPES.RECALL_PERFORMED,
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      traceId: context.traceId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      stageId: context.currentStageId,
      correlationId: context.traceId,
      actor: { type: "worker", id: "context-recall-engine" },
      source: { adapter: "harness-core", adapterVersion: "0.3.0" },
      policyVersion: "recall-policy-1",
      payload: {
        request,
        candidates: candidates.map((item) => ({ assetType: item.assetType, assetId: item.assetId, score: item.score })),
        selectedAssetIds: items.map((item) => item.assetId),
        estimatedTokens,
        tokenBudget: request.tokenBudget,
        disabled: request.disabled === true,
      },
    });
    return {
      recallEventId: event.event.eventId,
      items,
      estimatedTokens,
      omittedForBudget: candidates.length - items.length,
      disabled: request.disabled === true,
    };
  }

  recordFeedback(
    context: HarnessContext,
    recallEventId: string,
    assetId: string,
    adopted: boolean,
    reason: string,
  ): string {
    const recalled = this.ledger.getByIds([recallEventId])[0];
    const selected = Array.isArray(recalled?.payload.selectedAssetIds)
      ? recalled.payload.selectedAssetIds
      : [];
    if (recalled?.eventType !== EVENT_TYPES.RECALL_PERFORMED || !selected.includes(assetId)) {
      throw new Error("Feedback must refer to an asset selected by the given recall event.");
    }
    const event = this.ledger.append({
      eventType: EVENT_TYPES.RECALL_FEEDBACK_RECORDED,
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      traceId: context.traceId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      stageId: context.currentStageId,
      correlationId: context.traceId,
      causationId: recallEventId,
      actor: { type: "agent", id: "claude-code" },
      source: { adapter: "harness-mcp", adapterVersion: "0.3.0" },
      policyVersion: "recall-policy-1",
      payload: { recallEventId, assetId, adopted, reason },
    });
    return event.event.eventId;
  }
}

function scoreExperience(experience: Experience, request: RecallRequest): RecallItem[] {
  if (experience.context.taskType !== request.taskType) return [];
  const haystack = normalize(`${request.taskSummary} ${request.errorContext ?? ""} ${request.technologies.join(" ")}`);
  if (experience.exclusions.some((item) => haystack.includes(normalize(item)))) return [];
  const overlap = technologyOverlap(experience.context.technologies, request.technologies);
  const score = round(experience.confidence * 0.7 + overlap * 0.2 + stageBoost(request.stage) * 0.1);
  return [{
    assetType: "experience",
    assetId: experience.experienceId,
    score,
    reason: `Task type matched; technology overlap ${Math.round(overlap * 100)}%; confidence ${experience.confidence}.`,
    content: `${experience.title}\nApply when: ${experience.applicability.join(" ")}\nStrategy: ${experience.strategy}\nAvoid: ${experience.avoid.join(" ")}`,
    conflictAssetIds: experience.conflictExperienceIds,
  }];
}

function scoreSkill(skill: HarnessSkill, request: RecallRequest): RecallItem[] {
  if (!skill.trigger.taskTypes.includes(request.taskType)) return [];
  const haystack = normalize(`${request.taskSummary} ${request.errorContext ?? ""}`);
  if (skill.trigger.exclusions.some((item) => haystack.includes(normalize(item)))) return [];
  const overlap = technologyOverlap(skill.trigger.technologies, request.technologies);
  const score = round(0.7 + overlap * 0.2 + stageBoost(request.stage) * 0.1);
  return [{
    assetType: "skill",
    assetId: skill.skillId,
    score,
    reason: `Completed Skill matched task type with ${Math.round(overlap * 100)}% technology overlap.`,
    content: skill.markdown,
    conflictAssetIds: [],
  }];
}

function technologyOverlap(asset: string[], requested: string[]): number {
  if (requested.length === 0) return 0;
  const normalized = new Set(asset.map(normalize));
  return requested.filter((item) => normalized.has(normalize(item))).length / requested.length;
}

function stageBoost(stage: Stage): number {
  return stage === "RECALL" || stage === "PLAN" ? 1 : 0.5;
}

function estimateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }
function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
