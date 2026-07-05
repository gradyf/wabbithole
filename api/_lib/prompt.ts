// Versioned extraction prompt + output schema. Bumping PROMPT_VERSION makes
// the question cache regenerate per article (old rows stay for existing
// banks; new extractions use the new version).

import { z } from 'zod';

export const PROMPT_VERSION = 1;
export const EXTRACTION_MODEL = 'claude-haiku-4-5';
export const QUESTIONS_PER_ARTICLE = 5;

// Count/range constraints are enforced in code after parsing (structured
// outputs strips unsupported schema constraints), so the schema stays plain.
export const QuestionsSchema = z.object({
  questions: z.array(
    z.object({
      prompt: z.string().describe('The question, self-contained and specific'),
      choices: z.array(z.string()).describe('Exactly 4 answer choices, one correct'),
      answerIndex: z.number().int().describe('Position of the correct choice, 0 to 3'),
      explanation: z
        .string()
        .describe('One sentence stating the fact that makes the answer correct'),
    }),
  ),
});

export type ExtractedQuestion = z.infer<typeof QuestionsSchema>['questions'][number];

export function buildExtractionPrompt(args: {
  title: string;
  description?: string;
  text: string;
}): string {
  return `You are generating quiz questions for a personal trivia bank. Readers collect these after reading a Wikipedia article, then quiz themselves later to remember what they learned.

Write exactly ${QUESTIONS_PER_ARTICLE} multiple-choice questions from the article text below.

Rules:
- Every question must be answerable from the article text alone. Never rely on outside knowledge for the correct answer.
- Each question has exactly 4 choices with exactly one defensibly correct answer. Set answerIndex to the correct choice's position (0-3), and vary that position across questions.
- Write self-contained questions: someone reviewing a week later must understand the question without the article in front of them. Name the subject explicitly; never write "according to the article" or "as mentioned above".
- Distractors must be plausible and from the same domain (real related names, dates, places where possible) so guessing is hard.
- No meta-questions about the article itself (its sections, images, or editors). Ask about the subject.
- Prefer the interesting and memorable over the obscure: the facts a curious person would retell to a friend.
- Mix difficulty: roughly 2 easy, 2 medium, 1 hard.
- explanation: one sentence stating the fact that makes the answer correct.
- Write the questions in the same language as the article text.

Article title: ${args.title}
${args.description ? `Short description: ${args.description}\n` : ''}
Article text (may be truncated):
${args.text}`;
}

// Post-parse validation: keep only well-formed questions.
export function validQuestions(qs: ExtractedQuestion[]): ExtractedQuestion[] {
  return qs.filter(
    (q) =>
      q.prompt.trim().length > 0 &&
      q.choices.length === 4 &&
      q.choices.every((c) => c.trim().length > 0) &&
      Number.isInteger(q.answerIndex) &&
      q.answerIndex >= 0 &&
      q.answerIndex <= 3 &&
      q.explanation.trim().length > 0,
  );
}
