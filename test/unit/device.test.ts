/**
 * [INPUT]: core/device 的 cleanHost
 * [OUTPUT]: 设备名清洗的测试
 * [POS]: 单测
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { expect, it } from "vitest";
import { cleanHost } from "../../src/core/device";

it("Mac 主机名洗成机型，别的原样", () => {
  expect(cleanHost("haorandeMacBook-Pro.local")).toBe("MacBook Pro");
  expect(cleanHost("haoran的MacBook Pro")).toBe("MacBook Pro");
  expect(cleanHost("Haorans-MacBook-Air.local")).toBe("MacBook Air");
  expect(cleanHost("my-imac")).toBe("my imac");
  expect(cleanHost("DESKTOP-ABC123")).toBe("DESKTOP ABC123");
  expect(cleanHost("")).toBe("这台电脑");
});
