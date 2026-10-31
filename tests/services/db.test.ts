import { describe, expect, test } from "bun:test";

import { DB } from "../../src/services/db";

describe("DB", () => {
  test("migrate идемпотентен и не мешает работе", () => {
    const db = new DB(":memory:");

    db.set("state:ok", "value");
    expect(() => db.migrate()).not.toThrow();
    expect(db.get("state:ok")).toBe("value");

    db.close();
  });

  test("set/get roundtrip строкового значения", () => {
    const db = new DB(":memory:");

    expect(db.get("state:chat:-100")).toBeNull();

    db.set("state:chat:-100", "some value");
    expect(db.get("state:chat:-100")).toBe("some value");

    db.close();
  });

  test("set перезаписывает значение по существующему ключу", () => {
    const db = new DB(":memory:");

    db.set("clip:notify:42", "first");
    db.set("clip:notify:42", "second");

    expect(db.get("clip:notify:42")).toBe("second");
    expect(db.delete("clip:notify:42")).toBe(true);
    expect(db.delete("clip:notify:42")).toBe(false);

    db.close();
  });

  test("delete удаляет ключ и сообщает, было ли что удалять", () => {
    const db = new DB(":memory:");

    db.set("tmp:key", "value");

    expect(db.delete("tmp:key")).toBe(true);
    expect(db.get("tmp:key")).toBeNull();
    expect(db.delete("tmp:key")).toBe(false);

    db.close();
  });

  test("setJson/getJson сериализует объекты и структуры", () => {
    const db = new DB(":memory:");

    db.setJson("state:clip:42", { pending: [1, 2], total: 2, meta: null });

    const stored = db.getJson<{ pending: number[]; total: number; meta: null }>("state:clip:42");
    expect(stored).toEqual({ pending: [1, 2], total: 2, meta: null });

    db.setJson("state:num", 7);
    expect(db.getJson<number>("state:num")).toBe(7);

    expect(db.getJson("state:absent")).toBeNull();

    db.close();
  });

  test("getJson возвращает null для невалидного JSON", () => {
    const db = new DB(":memory:");

    db.set("state:broken", "{not-a-json");
    expect(db.getJson("state:broken")).toBeNull();

    db.close();
  });
});
