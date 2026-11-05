import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBridgeLine } from "./bridge-client.js";

describe("parseBridgeLine", () => {
  it("returns protocol messages", () => {
    const ready = { jsonrpc: "2.0", method: "bridge.ready", params: { protocolVersion: 1 } };
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    assert.deepEqual(parseBridgeLine(JSON.stringify(ready)), ready);
    assert.deepEqual(parseBridgeLine(JSON.stringify(response)), response);
  });

  it("skips dsh's own stdout log lines", () => {
    // The deepseek-account model catalog logs to stdout in dsh 0.2.1; the
    // bridge must not treat that line as a protocol failure.
    assert.equal(
      parseBridgeLine(
        "[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)",
      ),
      undefined,
    );
    assert.equal(parseBridgeLine('{"truncated":'), undefined);
  });

  it("skips JSON that is not a protocol object", () => {
    for (const line of ["null", "42", '"log"', "[]", "true"]) assert.equal(parseBridgeLine(line), undefined);
  });
});

