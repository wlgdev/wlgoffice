import { describe, expect, test } from "bun:test";

import { TrackerMatcher } from "../../src/tracker/matcher";

function makeMatcher(aliases: Record<string, string[]>, dedupeWindowSec = 30): TrackerMatcher {
  return new TrackerMatcher(aliases, { dedupeWindowSec });
}

/** Гоним поток чанков без совпадений: слова уникальны, так что перекрытий между чанками нет. */
function feedFiller(matcher: TrackerMatcher, count: number): void {
  for (let i = 0; i < count; i++) {
    matcher.push({ text: `шаг${i} слово${i}`, timeSec: i });
  }
}

describe("tracker matcher", () => {
  test("регистронезависимо для латиницы и кириллицы", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"], джи: ["Джи Джи Сел"] });

    expect(matcher.push({ text: "GGSel", timeSec: 10 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 10 }]);
    expect(matcher.push({ text: "ДЖИ ДЖИ СЕЛ", timeSec: 20 })).toEqual([
      { alias: "джи", text: "джи джи сел", timeSec: 20 },
    ]);
  });

  test("разделители внутри паттерна запрещены", () => {
    const matcher = makeMatcher({ джи: ["джи джи сел"] });

    expect(matcher.push({ text: "джи.джи.сел", timeSec: 10 })).toEqual([]);
    expect(matcher.push({ text: "джи, джи... сел!", timeSec: 20 })).toEqual([]);
    expect(matcher.push({ text: "джиджисел", timeSec: 30 })).toEqual([]);
  });

  test("пунктуация и пробелы допустимы до и после паттерна", () => {
    expect(makeMatcher({ ggsel: ["ggsel"] }).push({ text: "... ggsel!", timeSec: 10 })).toEqual([
      { alias: "ggsel", text: "ggsel", timeSec: 10 },
    ]);
    expect(makeMatcher({ ggsel: ["ggsel"] }).push({ text: "(ggsel)", timeSec: 20 })).toEqual([
      { alias: "ggsel", text: "ggsel", timeSec: 20 },
    ]);
  });

  test("паттерн не склеивается с буквами и цифрами", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "ggseltron", timeSec: 10 })).toEqual([]);
    expect(matcher.push({ text: "xggsel", timeSec: 20 })).toEqual([]);
    expect(matcher.push({ text: "ggsel2", timeSec: 30 })).toEqual([]);
  });

  test("подчёркивание считается частью слова", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "ggsel_bot", timeSec: 10 })).toEqual([]);
    expect(matcher.push({ text: "my_ggsel", timeSec: 20 })).toEqual([]);
  });

  test("паттерн нормализуется: trim и регистр", () => {
    const matcher = makeMatcher({ ggsel: ["  GGSel "] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 10 }]);
  });

  test("паттерн с небуквенным краем матчится без границы слова с этой стороны", () => {
    const matcher = makeMatcher({ тег: ["#ggsel"] });

    expect(matcher.push({ text: "тег #ggsel!", timeSec: 10 })).toEqual([{ alias: "тег", text: "#ggsel", timeSec: 10 }]);
  });

  test("спецсимволы regexp в паттернах экранируются", () => {
    const matcher = makeMatcher({ точка: ["a.b"], плюсы: ["c++"] });

    expect(matcher.push({ text: "axb", timeSec: 10 })).toEqual([]);
    expect(matcher.push({ text: "a.b", timeSec: 20 })).toEqual([{ alias: "точка", text: "a.b", timeSec: 20 }]);
    expect(matcher.push({ text: "c++", timeSec: 30 })).toEqual([{ alias: "плюсы", text: "c++", timeSec: 30 }]);
  });

  test("пустые алиасы и пустой набор ничего не находят и не падают", () => {
    expect(makeMatcher({ a: ["", "   "] }).push({ text: "любой текст", timeSec: 10 })).toEqual([]);
    expect(makeMatcher({}).push({ text: "любой текст", timeSec: 10 })).toEqual([]);
  });

  test("пустой чанк игнорируется", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "", timeSec: 10 })).toEqual([]);
    expect(matcher.push({ text: "ggsel", timeSec: 20 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 20 }]);
  });

  test("все алиасы проверяются одновременно", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"], привет: ["привет"] });

    const hits = matcher.push({ text: "привет, ggsel!", timeSec: 42 });
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.alias).sort()).toEqual(["ggsel", "привет"]);
    expect(hits.every((hit) => hit.timeSec === 42)).toBe(true);
  });

  test("несколько вхождений в одном чанке считаются все", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "ggsel и ggsel и ggsel", timeSec: 10 })).toEqual([
      { alias: "ggsel", text: "ggsel", timeSec: 10 },
      { alias: "ggsel", text: "ggsel", timeSec: 10 },
      { alias: "ggsel", text: "ggsel", timeSec: 10 },
    ]);
  });

  test("два паттерна одного алиаса в одном месте дают один хит", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel", "ggse"] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 10 }]);
  });

  test("перекрывающиеся паттерны одного алиаса: побеждает более длинный", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel", "ggsel market"] });

    expect(matcher.push({ text: "ggsel market", timeSec: 10 })).toEqual([
      { alias: "ggsel", text: "ggsel market", timeSec: 10 },
    ]);
  });

  test("ограничение: если короткий паттерн уже засчитан в прошлом чанке, длинный по следующему не добавляется", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel", "ggsel market"] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 10 }]);
    expect(matcher.push({ text: "market", timeSec: 20 })).toEqual([]);
  });

  test("разные формы одного алиаса дедупятся независимо", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel", "гг сел"] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 10 }]);
    expect(matcher.push({ text: "гг сел", timeSec: 20 })).toEqual([{ alias: "ggsel", text: "гг сел", timeSec: 20 }]);
  });

  test("таймстемп берётся от начала совпадения", () => {
    const matcher = makeMatcher({ джи: ["джи джи сел"] });

    matcher.push({ text: "джи джи", timeSec: 10 });
    expect(matcher.push({ text: "сел", timeSec: 20 })).toEqual([{ alias: "джи", text: "джи джи сел", timeSec: 10 }]);
  });

  test("дедуп по окну: тот же алиас и текст повторяется через 31 секунду", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "ggsel", timeSec: 100 })).toHaveLength(1);
    expect(matcher.push({ text: "ggsel", timeSec: 131 })).toHaveLength(1);
  });

  test("повтор ровно на границе окна ещё схлопывается в первый таймкод", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    matcher.push({ text: "ggsel", timeSec: 100 });
    expect(matcher.push({ text: "ggsel", timeSec: 130 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 100 }]);
  });

  test("окно дедупа настраивается", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] }, 5);

    expect(matcher.push({ text: "ggsel", timeSec: 100 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 100 }]);
    expect(matcher.push({ text: "ggsel", timeSec: 104 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 100 }]);
    expect(matcher.push({ text: "ggsel", timeSec: 111 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 111 }]);
  });

  test("повтор в пределах окна схлопывается в первый таймкод, но считается", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "ggsel", timeSec: 100 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 100 }]);
    expect(matcher.push({ text: "и снова ggsel", timeSec: 120 })).toEqual([
      { alias: "ggsel", text: "ggsel", timeSec: 100 },
    ]);
    expect(matcher.push({ text: "и опять ggsel", timeSec: 129 })).toEqual([
      { alias: "ggsel", text: "ggsel", timeSec: 100 },
    ]);
  });

  test("повтор за пределами окна получает свой таймкод", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    matcher.push({ text: "ggsel", timeSec: 100 });
    expect(matcher.push({ text: "и снова ggsel", timeSec: 140 })).toEqual([
      { alias: "ggsel", text: "ggsel", timeSec: 140 },
    ]);
  });

  test("перекрывающийся чанк не создаёт дубль", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    matcher.push({ text: "давайте обсудим ggsel подробнее", timeSec: 10 });
    const hits = matcher.push({ text: "ggsel подробнее и ещё немного", timeSec: 20 });

    expect(hits).toEqual([]);
  });

  test("перекрывающийся чанк: новое вхождение в продолжении находится", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "давайте обсудим ggsel", timeSec: 10 })).toHaveLength(1);
    expect(matcher.push({ text: "обсудим ggsel и ещё ggsel", timeSec: 20 })).toEqual([
      { alias: "ggsel", text: "ggsel", timeSec: 10 },
    ]);
  });

  test("короткое совпадение хвоста (меньше порога символов) не считается перекрытием", () => {
    const matcher = makeMatcher({ ха: ["ха"] });

    expect(matcher.push({ text: "ха ха", timeSec: 10 })).toHaveLength(2);
    expect(matcher.push({ text: "ха ха", timeSec: 20 })).toHaveLength(2);
  });

  test("полностью повторённый чанк игнорируется", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    matcher.push({ text: "мы говорим про ggsel и ggsel", timeSec: 10 });
    expect(matcher.push({ text: "мы говорим про ggsel и ggsel", timeSec: 20 })).toEqual([]);
  });

  test("курсор не даёт повторных совпадений при сканировании буфера", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toHaveLength(1);
    expect(matcher.push({ text: "обычный текст без совпадений", timeSec: 20 })).toEqual([]);
    expect(matcher.push({ text: "ещё текст", timeSec: 30 })).toEqual([]);
  });

  test("повтор в хвосте чанка не пересчитывается следующим чанком (длинный соседний паттерн)", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"], длинный: ["очень длинная фраза для паттерна"] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 10 }]);
    expect(matcher.push({ text: "ggsel", timeSec: 20 })).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: 10 }]);
    expect(matcher.push({ text: "привет", timeSec: 30 })).toEqual([]);
  });

  test("алиас в хвосте чанка не считается заново после паузы длиннее окна", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"], длинный: ["очень длинная фраза для паттерна"] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toHaveLength(1);
    expect(matcher.push({ text: "что-то совсем другое", timeSec: 50 })).toEqual([]);
  });

  test("алиасы переключаются на лету", () => {
    const matcher = makeMatcher({ ggsel: ["ggsel"] });

    expect(matcher.push({ text: "ggsel", timeSec: 10 })).toHaveLength(1);
    matcher.setAliases({ другое: ["ggsel"] });
    expect(matcher.push({ text: "ggsel", timeSec: 20 })).toEqual([{ alias: "другое", text: "ggsel", timeSec: 20 }]);
  });

  describe("длинная сессия и обрезка буфера", () => {
    test("хиты не теряются и не дублируются, буфер ограничен", () => {
      const matcher = makeMatcher({ ggsel: ["ggsel"] });

      for (let i = 0; i < 2000; i++) {
        const hits = matcher.push({ text: `ggsel шаг${i}`, timeSec: i * 100 });

        expect(hits).toEqual([{ alias: "ggsel", text: "ggsel", timeSec: i * 100 }]);
        expect(matcher["buffer"].length).toBeLessThanOrEqual(4000);
      }
    });

    test("совпадение через границу чанков после обрезки сохраняет таймкод начала", () => {
      const matcher = makeMatcher({ джи: ["джи джи сел"] });

      feedFiller(matcher, 1000);
      expect(matcher["buffer"].length).toBeLessThanOrEqual(4000);

      expect(matcher.push({ text: "джи джи", timeSec: 5000 })).toEqual([]);
      expect(matcher.push({ text: "сел", timeSec: 5010 })).toEqual([
        { alias: "джи", text: "джи джи сел", timeSec: 5000 },
      ]);
    });

    test("дедуп в окне работает и после обрезки", () => {
      const matcher = makeMatcher({ ggsel: ["ggsel"] });

      feedFiller(matcher, 1000);
      expect(matcher.push({ text: "ggsel", timeSec: 5000 })).toEqual([
        { alias: "ggsel", text: "ggsel", timeSec: 5000 },
      ]);
      expect(matcher.push({ text: "и снова ggsel", timeSec: 5010 })).toEqual([
        { alias: "ggsel", text: "ggsel", timeSec: 5000 },
      ]);
    });
  });
});
