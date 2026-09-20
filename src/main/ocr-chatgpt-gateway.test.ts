import { describe, expect, it } from "vitest";

import { OcrChatGptGateway, parseToolCallingResponse } from "./ocr-chatgpt-gateway";

const tools = [{
  type: "function" as const,
  function: {
    name: "file_read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
}];

describe("OCR ChatGPT Web OpenAI gateway", () => {
  it("serves a bearer-authenticated OpenAI-compatible tool-call response on loopback", async () => {
    const fakeDriver = {
      startTask: async () => ({ conversationUrl: null, fallbackToNewConversation: false }),
      send: async () => ({
        text: "[OCR_OPENAI_RESPONSE]\n{\"content\":\"\",\"tool_calls\":[{\"id\":\"call_read\",\"name\":\"file_read\",\"arguments\":{\"path\":\"src/a.ts\"}}]}\n[/OCR_OPENAI_RESPONSE]",
        conversationUrl: "https://chatgpt.com/c/fake",
      }),
      finishTask: () => undefined,
    };
    const gateway = new OcrChatGptGateway(fakeDriver as any, "https://chatgpt.com/g/g-p-fake/project");
    const binding = await gateway.start();
    try {
      const unauthorized = await fetch(`${binding.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: binding.model, messages: [{ role: "user", content: "review" }] }),
      });
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`${binding.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${binding.token}`,
        },
        body: JSON.stringify({
          model: binding.model,
          messages: [{ role: "user", content: "review" }],
          tools,
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.choices[0].finish_reason).toBe("tool_calls");
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("file_read");
      expect(body.usage.total_tokens).toBeGreaterThan(0);
    } finally {
      await gateway.stop();
    }
  });


  it("streams deduplicated OCR tool results into review progress with secret redaction", async () => {
    const progress: string[] = [];
    const fakeDriver = {
      startTask: async () => ({ conversationUrl: null, fallbackToNewConversation: false }),
      send: async () => ({
        text: "[OCR_OPENAI_RESPONSE]\n{\"content\":\"Review complete.\",\"tool_calls\":[]}\n[/OCR_OPENAI_RESPONSE]",
        conversationUrl: "https://chatgpt.com/c/fake",
      }),
      finishTask: () => undefined,
    };
    const gateway = new OcrChatGptGateway(
      fakeDriver as any,
      "https://chatgpt.com/g/g-p-fake/project",
      (message) => progress.push(message),
      "review_0123456789abcdef",
    );
    const binding = await gateway.start();
    try {
      const payload = {
        model: binding.model,
        messages: [
          { role: "user", content: "review" },
          {
            role: "tool",
            tool_call_id: "call_read",
            content: "{\"token\":\"super-secret-value\",\"path\":\"src/a.ts\",\"result\":\"ok\"}",
          },
        ],
      };
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${binding.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${binding.token}`,
          },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
      }

      const toolResultProgress = progress.filter((message) => message.startsWith("OCR tool result call_read:"));
      expect(toolResultProgress).toHaveLength(1);
      expect(toolResultProgress[0]).toContain("[REDACTED]");
      expect(toolResultProgress[0]).toContain("src/a.ts");
      expect(toolResultProgress[0]).not.toContain("super-secret-value");
    } finally {
      await gateway.stop();
    }
  });

  it("maps structured ChatGPT Web output into native OpenAI tool calls", () => {
    const parsed = parseToolCallingResponse(
      "[OCR_OPENAI_RESPONSE]\\n{\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"name\":\"file_read\",\"arguments\":{\"path\":\"src/a.ts\"}}]}\\n[/OCR_OPENAI_RESPONSE]".replaceAll("\\n", "\n"),
      tools,
    );

    expect(parsed.content).toBe("");
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.function.name).toBe("file_read");
    expect(JSON.parse(parsed.toolCalls[0]!.function.arguments)).toEqual({ path: "src/a.ts" });
  });

  it("accepts a final assistant response with no tool calls", () => {
    const parsed = parseToolCallingResponse(
      "[OCR_OPENAI_RESPONSE]\\n{\"content\":\"Review complete.\",\"tool_calls\":[]}\\n[/OCR_OPENAI_RESPONSE]".replaceAll("\\n", "\n"),
      tools,
    );
    expect(parsed.content).toBe("Review complete.");
    expect(parsed.toolCalls).toEqual([]);
  });

  it("rejects tool names that OCR did not expose", () => {
    expect(() => parseToolCallingResponse(
      "[OCR_OPENAI_RESPONSE]\\n{\"content\":\"\",\"tool_calls\":[{\"name\":\"shell_exec\",\"arguments\":{\"command\":\"rm -rf /\"}}]}\\n[/OCR_OPENAI_RESPONSE]".replaceAll("\\n", "\n"),
      tools,
    )).toThrow(/unknown OCR tool/i);
  });
});
