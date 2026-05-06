import { describe, expect, test } from "bun:test";
import {
  buildQuestionAnswers,
  normalizeQuestionItems,
  toggleMultiSelectAnswer,
} from "../../webview-ui/src/components/agentRequestModel.js";

describe("agent intervention request model", () => {
  test("normalizes every Kimi QuestionRequest item instead of dropping after the first", () => {
    const questions = normalizeQuestionItems({
      questions: [
        {
          question: "Which language should I use?",
          header: "Lang",
          options: [
            { label: "Python", description: "Large ecosystem" },
            { label: "Rust", description: "Fast and safe" },
          ],
        },
        {
          question: "Which constraints matter?",
          header: "Rules",
          multi_select: true,
          options: [
            { label: "Speed" },
            { label: "Safety" },
            { label: "DX" },
          ],
        },
      ],
    });

    expect(questions.map((question) => question.question)).toEqual([
      "Which language should I use?",
      "Which constraints matter?",
    ]);
    expect(questions[0].header).toBe("Lang");
    expect(questions[1].multiSelect).toBe(true);
    expect(questions[1].options.map((option) => option.label)).toEqual(["Speed", "Safety", "DX"]);
  });

  test("builds Wire QuestionResponse answers using question text as keys", () => {
    const questions = normalizeQuestionItems({
      questions: [
        {
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
        },
        {
          question: "Pick many",
          multi_select: true,
          options: [{ label: "Fast" }, { label: "Safe" }, { label: "Cheap" }],
        },
        {
          question: "Any note?",
          options: [],
        },
      ],
    });

    const answers = buildQuestionAnswers(questions, {
      "Pick one": "B",
      "Pick many": ["Safe", "Fast"],
      "Any note?": "Ship the minimal slice.",
    });

    expect(answers).toEqual({
      "Pick one": "B",
      "Pick many": "Fast, Safe",
      "Any note?": "Ship the minimal slice.",
    });
  });

  test("multi-select toggling preserves option order and removes deselected labels", () => {
    const question = normalizeQuestionItems({
      questions: [
        {
          question: "Pick many",
          multi_select: true,
          options: [{ label: "Fast" }, { label: "Safe" }, { label: "Cheap" }],
        },
      ],
    })[0];

    let selected = toggleMultiSelectAnswer(question, [], "Safe");
    selected = toggleMultiSelectAnswer(question, selected, "Fast");
    expect(selected).toEqual(["Fast", "Safe"]);

    selected = toggleMultiSelectAnswer(question, selected, "Safe");
    expect(selected).toEqual(["Fast"]);
  });
});
