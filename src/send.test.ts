import { describe, it, expect } from "vitest";
import { parseInteractiveButtons } from "./send.js";

describe("parseInteractiveButtons", () => {
  it("returns null for text without template", () => {
    expect(parseInteractiveButtons("Hello world")).toBeNull();
    expect(parseInteractiveButtons("")).toBeNull();
  });

  it("parses 3-part template (title | body | buttons)", () => {
    const result = parseInteractiveButtons(
      "[[buttons: 晚餐選擇 | 今晚想吃什麼？ | 拉麵:ramen, 披薩:pizza, 沙拉:salad]]"
    );
    expect(result).not.toBeNull();
    expect(result!.text).toBe("今晚想吃什麼？");
    expect(result!.interactive.type).toBe("buttons");
    expect(result!.interactive.buttons).toHaveLength(3);
    expect(result!.interactive.buttons![0]).toEqual({ id: "ramen", label: "拉麵" });
    expect(result!.interactive.buttons![1]).toEqual({ id: "pizza", label: "披薩" });
    expect(result!.interactive.buttons![2]).toEqual({ id: "salad", label: "沙拉" });
  });

  it("parses 2-part template (body | buttons)", () => {
    const result = parseInteractiveButtons(
      "[[buttons: 確認嗎？ | 是:yes, 否:no]]"
    );
    expect(result).not.toBeNull();
    expect(result!.text).toBe("確認嗎？");
    expect(result!.interactive.buttons).toHaveLength(2);
    expect(result!.interactive.buttons![0]).toEqual({ id: "yes", label: "是" });
    expect(result!.interactive.buttons![1]).toEqual({ id: "no", label: "否" });
  });

  it("uses label as id when no colon", () => {
    const result = parseInteractiveButtons(
      "[[buttons: Pick | Yes, No, Maybe]]"
    );
    expect(result).not.toBeNull();
    expect(result!.interactive.buttons![0]).toEqual({ id: "Yes", label: "Yes" });
    expect(result!.interactive.buttons![1]).toEqual({ id: "No", label: "No" });
    expect(result!.interactive.buttons![2]).toEqual({ id: "Maybe", label: "Maybe" });
  });

  it("preserves surrounding text", () => {
    const result = parseInteractiveButtons(
      "請選擇 [[buttons: 選項 | A:a, B:b]] 謝謝"
    );
    expect(result).not.toBeNull();
    expect(result!.text).toBe("選項\n\n請選擇  謝謝");
  });

  it("returns null for template with only 1 part", () => {
    expect(parseInteractiveButtons("[[buttons: only_one]]")).toBeNull();
  });

  it("returns null for empty buttons", () => {
    expect(parseInteractiveButtons("[[buttons: title | ]]")).toBeNull();
  });
});

describe("uploadMediaWristClaw", () => {
  it("is exported and callable", async () => {
    const { uploadMediaWristClaw } = await import("./send.js");
    expect(typeof uploadMediaWristClaw).toBe("function");
  });
});
