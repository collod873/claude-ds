export interface ReviewOutput {
  approved: boolean;
  summary: string;
  issues: ReviewIssue[];
}

export interface ReviewIssue {
  severity: "error" | "warning" | "suggestion";
  file: string;
  line?: number;
  message: string;
}
