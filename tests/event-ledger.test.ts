import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EventLedger } from "../src/storage/event-ledger.js";
import type { CapturedEvent } from "../src/domain/events.js";

const temporaryDirectories: string[] = [];
const openLedgers: EventLedger[] = [];

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // A test may already have closed it.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) {
      throw new Error(`Refusing to remove non-temporary path: ${target}`);
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function createLedger(): { ledger: EventLedger; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-harness-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "events.sqlite");
  const ledger = new EventLedger(databasePath);
  openLedgers.push(ledger);
  return { ledger, databasePath };
}

function event(overrides: Partial<CapturedEvent> = {}): CapturedEvent {
  return {
    eventId: "evt-one",
    eventType: "session.started",
    occurredAt: "2026-09-06T08:00:00.000Z",
    runtimeInstanceId: "runtime-one",
    sessionId: "session-one",
    correlationId: "session-one",
    actor: { type: "hook", id: "claude-code" },
    source: { adapter: "claude-code", adapterVersion: "2.1.220" },
    policyVersion: "policy-one",
    payload: { authorization: "Bearer should-not-persist", reason: "startup" },
    ...overrides,
  };
}

describe("event ledger", () => {
  it("redacts before append and verifies the hash chain", () => {
    const { ledger } = createLedger();
    const first = ledger.append(event());
    const second = ledger.append(
      event({ eventId: "evt-two", eventType: "turn.started", turnId: "turn-one" }),
    );

    expect(first.created).toBe(true);
    expect(second.sequence).toBe(2);
    expect(ledger.list()[0]?.payload.authorization).toBe("<REDACTED>");
    expect(ledger.verifyChain()).toEqual({ valid: true, checkedEvents: 2 });
    ledger.close();
  });

  it("is idempotent for the same event", () => {
    const { ledger } = createLedger();
    expect(ledger.append(event()).created).toBe(true);
    expect(ledger.append(event()).created).toBe(false);
    expect(ledger.list()).toHaveLength(1);
    ledger.close();
  });

  it("rejects an event ID collision", () => {
    const { ledger } = createLedger();
    ledger.append(event());
    expect(() => ledger.append(event({ payload: { reason: "different" } }))).toThrow(
      "Event ID collision",
    );
    ledger.close();
  });

  it("prevents updates at the database layer", () => {
    const { ledger, databasePath } = createLedger();
    ledger.append(event());
    ledger.close();

    const database = new Database(databasePath);
    expect(() => database.prepare("UPDATE events SET event_type = 'changed'").run()).toThrow(
      "events are immutable",
    );
    database.close();
  });
});
