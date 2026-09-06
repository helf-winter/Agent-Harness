import { describe, expect, it } from "vitest";
import { redact } from "../src/security/redactor.js";

describe("redactor", () => {
  it("redacts sensitive keys and inline credentials", () => {
    const result = redact({
      authorization: "Bearer abc.def.ghi",
      nested: {
        apiKey: "sk-ant-private-value",
        log: "request used Bearer another-token",
      },
    });

    expect(result.value).toEqual({
      authorization: "<REDACTED>",
      nested: {
        apiKey: "<REDACTED>",
        log: "request used Bearer <REDACTED>",
      },
    });
    expect(result.redactedFields).toEqual([
      "authorization",
      "nested.apiKey",
      "nested.log",
    ]);
  });

  it("normalizes the user home path", () => {
    const result = redact("/home/alice/work/private/file.ts", { userHome: "/home/alice" });
    expect(result.value).toBe("<USER_HOME>/work/private/file.ts");
  });
});
