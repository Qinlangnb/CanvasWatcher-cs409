// File types: lecture, homework, discussion, reading, exam, solution or other. Ported from the
// original downloader's built-in rules (English and Chinese); the first rule that matches wins, so
// "HW 3 solutions" is a solution and "Midterm review slides" an exam.

export const FILE_TYPES = ["lecture", "homework", "discussion", "reading", "exam", "solution", "other"] as const;
export type FileType = (typeof FILE_TYPES)[number];

const RULES: [RegExp, FileType][] = [
  [/(?<![a-z0-9])(?:solutions?|solns?|sol(?=[\W_]*\d)|answer[\W_]*keys?|answers?)(?![a-z])|参考答案|解答|题解/i, "solution"],
  [/(?<![a-z0-9])(?:exams?|midterms?|final[\W_]*exam|quizzes|quiz)(?![a-z])|期中|期末|试卷/i, "exam"],
  [/(?<![a-z0-9])(?:discussions?|disc|dis(?=[\W_]*\d)|recitations?|tutorials?)(?![a-z])|讨论课|习题课/i, "discussion"],
  [/(?<![a-z0-9])(?:homework|hw|problem[\W_]*sets?|pset|assignments?)(?![a-z])|作业/i, "homework"],
  [/(?<![a-z0-9])(?:lectures?|lec|slides?|class[\W_]*notes?)(?![a-z])|讲义|课件/i, "lecture"],
  [/(?<![a-z0-9])(?:readings?|optional|supplement(?:al|ary)?|syllabus|handbooks?|papers?)(?![a-z])|阅读|教学大纲/i, "reading"],
];

/** Classifies a name or path; URLs count only by their path (signed queries are not names). */
export function classifyFile(text: string): FileType {
  let context = text.replace(/https?:\/\/\S+/g, (match) => {
    try {
      return new URL(match).pathname;
    } catch {
      return match;
    }
  });
  try {
    context = decodeURIComponent(context);
  } catch {
    // Keep the text as it is.
  }
  return RULES.find(([pattern]) => pattern.test(context))?.[1] ?? "other";
}

/** The file's own name first; where it says nothing, the titles of the assignments linking it. */
export function detectFileType(name: string, contextTitles: string[] = []): FileType {
  const own = classifyFile(name);
  if (own !== "other" || contextTitles.length === 0) return own;
  return classifyFile(contextTitles.join(" "));
}

export const isFileType = (value: unknown): value is FileType => FILE_TYPES.includes(value as FileType);

/** The student's choice wins over what sync detected. */
export function effectiveFileType(file: { detectedType: string; userOverrideType: string | null }): FileType {
  if (isFileType(file.userOverrideType)) return file.userOverrideType;
  return isFileType(file.detectedType) ? file.detectedType : "other";
}
