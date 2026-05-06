export interface NormalizedQuestionOption {
  label: string
  description: string
}

export interface NormalizedQuestionItem {
  question: string
  header?: string
  options: NormalizedQuestionOption[]
  multiSelect: boolean
}

export type QuestionDraftValue = string | string[] | undefined

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeOptions(rawOptions: unknown): NormalizedQuestionOption[] {
  if (!Array.isArray(rawOptions)) return []
  const options: NormalizedQuestionOption[] = []
  for (const raw of rawOptions) {
    const option = asRecord(raw)
    const label = cleanString(option.label)
    if (!label) continue
    options.push({ label, description: cleanString(option.description) })
  }
  return options
}

export function normalizeQuestionItems(payload: Record<string, unknown>): NormalizedQuestionItem[] {
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : []
  const questions: NormalizedQuestionItem[] = []

  for (const raw of rawQuestions) {
    const item = asRecord(raw)
    const question = cleanString(item.question)
    if (!question) continue
    const header = cleanString(item.header)
    questions.push({
      question,
      header: header || undefined,
      options: normalizeOptions(item.options),
      multiSelect: item.multi_select === true,
    })
  }

  if (questions.length > 0) return questions
  return [{ question: 'Question from Kimi', options: [], multiSelect: false }]
}

export function toggleMultiSelectAnswer(
  question: NormalizedQuestionItem,
  current: string[] | undefined,
  label: string,
): string[] {
  const currentSet = new Set(current || [])
  if (currentSet.has(label)) {
    currentSet.delete(label)
  } else {
    currentSet.add(label)
  }

  const optionOrder = question.options.map((option) => option.label)
  return optionOrder.filter((optionLabel) => currentSet.has(optionLabel))
}

export function answerValueToText(question: NormalizedQuestionItem, value: QuestionDraftValue): string {
  if (Array.isArray(value)) {
    const selected = new Set(value.map((item) => item.trim()).filter(Boolean))
    return question.options
      .map((option) => option.label)
      .filter((label) => selected.has(label))
      .join(', ')
  }
  return typeof value === 'string' ? value.trim() : ''
}

export function buildQuestionAnswers(
  questions: NormalizedQuestionItem[],
  draft: Record<string, QuestionDraftValue>,
): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const answer = answerValueToText(question, draft[question.question])
    if (answer) answers[question.question] = answer
  }
  return answers
}

export function hasAnswerForEveryQuestion(
  questions: NormalizedQuestionItem[],
  draft: Record<string, QuestionDraftValue>,
): boolean {
  return questions.every((question) => answerValueToText(question, draft[question.question]).length > 0)
}
