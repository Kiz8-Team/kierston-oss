import { expect, test } from "bun:test";
import { Editor, Filter, ListState } from "../src/tui/state.ts";
import { Form, parseList, type FormRow } from "../src/tui/form.ts";
import { width } from "../src/format.ts";

test("a list cursor moves by arrows and pages, wraps on arrows, and never leaves the rows", () => {
  const list = new ListState();
  expect(list.onKey({ name: "down" }, 5, 3)).toBe(true);
  expect(list.cursor).toBe(1);
  list.onKey({ name: "pagedown" }, 5, 3);
  expect(list.cursor).toBe(4);
  list.onKey({ name: "pagedown" }, 5, 3);
  expect(list.cursor).toBe(4);
  list.onKey({ name: "down" }, 5, 3);
  expect(list.cursor).toBe(0);
  list.onKey({ name: "up" }, 5, 3);
  expect(list.cursor).toBe(4);
  list.onKey({ name: "home" }, 5, 3);
  expect(list.cursor).toBe(0);
  list.onKey({ name: "pageup" }, 5, 3);
  expect(list.cursor).toBe(0);
  list.onKey({ name: "up" }, 0, 3);
  expect(list.cursor).toBe(0);
  expect(list.onKey({ name: "left" }, 5, 3)).toBe(false);
  // Fewer rows than before: the cursor is pulled back inside them.
  list.cursor = 9;
  list.window(4, 2);
  expect(list.cursor).toBe(3);
  expect(list.offset).toBe(2);
});

test("an editor keeps a caret and edits around it", () => {
  const editor = new Editor("abc");
  expect(editor.caret).toBe(3);
  editor.onKey({ name: "left" });
  editor.onKey({ name: "char", ch: "X" });
  expect(editor.text).toBe("abXc");
  editor.onKey({ name: "home" });
  editor.onKey({ name: "delete" });
  expect(editor.text).toBe("bXc");
  editor.onKey({ name: "end" });
  editor.onKey({ name: "backspace" });
  expect(editor.text).toBe("bX");
  expect(editor.onKey({ name: "enter" })).toBe("done");
  expect(editor.onKey({ name: "escape" })).toBe("cancel");
  expect(width(editor.render())).toBe(3);
});

test("a filter is typed after slash, narrows as it goes, and esc clears it", () => {
  const filter = new Filter();
  expect(filter.onKey({ name: "char", ch: "x" })).toBe(false);
  expect(filter.onKey({ name: "char", ch: "/" })).toBe(true);
  expect(filter.typing).toBe(true);
  filter.onKey({ name: "char", ch: "S" });
  filter.onKey({ name: "char", ch: "m" });
  expect(filter.matches("example/smoke")).toBe(true);
  expect(filter.matches("example/other")).toBe(false);
  // Arrows fall through to the list while the filter is being typed.
  expect(filter.onKey({ name: "down" })).toBe(false);
  expect(filter.onKey({ name: "enter" })).toBe(true);
  expect(filter.typing).toBe(false);
  expect(filter.text).toBe("Sm");
  expect(filter.onKey({ name: "escape" })).toBe(true);
  expect(filter.text).toBe("");
  // With nothing to clear, esc is left for the page to mean "back".
  expect(filter.onKey({ name: "escape" })).toBe(false);
});

test("a form edits a text row in place, toggles, and presses buttons with enter", async () => {
  const state = { name: "one", on: false, pressed: 0, changed: 0 };
  const rows: FormRow[] = [
    { label: "Name", kind: "text", value: () => state.name, set: (text) => (state.name = text), changed: () => state.changed++ },
    { label: "On", kind: "toggle", value: () => (state.on ? "yes" : "no"), toggle: () => (state.on = !state.on) },
    { label: "Go", kind: "button", act: () => void state.pressed++ },
  ];
  const form = new Form(() => rows);
  await form.onKey({ name: "enter" });
  expect(form.capturing()).toBe(true);
  await form.onKey({ name: "char", ch: "s" });
  await form.onKey({ name: "enter" });
  expect(state.name).toBe("ones");
  expect(state.changed).toBe(1);
  expect(form.capturing()).toBe(false);
  // esc while editing discards the edit and nothing else sees the key.
  await form.onKey({ name: "enter" });
  await form.onKey({ name: "char", ch: "z" });
  // The edit shows while it is being typed, caret and all.
  expect(form.lines(60, 10)[0]).toContain("onesz");
  expect(await form.onKey({ name: "escape" })).toBe(true);
  expect(state.name).toBe("ones");
  // A letter on a row is not an edit: it stays free for the page's actions.
  expect(await form.onKey({ name: "char", ch: "r" })).toBe(false);
  await form.onKey({ name: "down" });
  await form.onKey({ name: "enter" });
  expect(state.on).toBe(true);
  await form.onKey({ name: "down" });
  await form.onKey({ name: "enter" });
  expect(state.pressed).toBe(1);
  // Left and right are not the form's: they switch tabs.
  expect(await form.onKey({ name: "left" })).toBe(false);
  const lines = form.lines(60, 10);
  expect(lines.some((line) => line.includes("▶ Go"))).toBe(true);
  expect(lines.some((line) => line.includes("ones"))).toBe(true);
});

test("a form keeps the selected row on screen when it is taller than the pane", async () => {
  const rows: FormRow[] = Array.from({ length: 12 }, (_, i) => ({ label: `F${i}`, kind: "text" as const, value: () => `v${i}`, set: () => {} }));
  const form = new Form(() => rows);
  for (let i = 0; i < 11; i++) await form.onKey({ name: "down" });
  const lines = form.lines(40, 5);
  expect(lines.length).toBeLessThanOrEqual(5);
  expect(lines.some((line) => line.includes("F11"))).toBe(true);
});

test("comma lists are split and trimmed", () => {
  expect(parseList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
  expect(parseList("")).toEqual([]);
});
