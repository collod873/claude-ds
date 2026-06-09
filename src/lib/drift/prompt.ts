import { createInterface } from "node:readline";

export interface PromptOption {
	label: string;
	description: string;
}

export type FixerPrompt = (question: string, options: PromptOption[]) => Promise<number | "defer">;

export function makeTtyPrompt(): FixerPrompt {
	return async (question: string, options: PromptOption[]): Promise<number | "defer"> => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const maxOptions = 5;
			const displayOptions =
				options.length > maxOptions
					? [
							...options.slice(0, maxOptions - 1),
							{
								label: `... and ${options.length - maxOptions + 1} more`,
								description: "defer to review",
							},
						]
					: options;
			const lines = displayOptions
				.map((opt, i) => `  \x1b[36m[${i + 1}]\x1b[0m ${opt.label} — ${opt.description}`)
				.join("\n");
			const display = `\n\x1b[1m${question}\x1b[0m\n${lines}\n  \x1b[90m[s] Skip/defer\x1b[0m\n\x1b[36m>\x1b[0m `;
			const answer = await new Promise<string>((resolve) => {
				rl.question(display, resolve);
			});
			const trimmed = answer.trim().toLowerCase();
			if (trimmed === "s" || trimmed === "skip" || trimmed === "defer") return "defer";
			const num = parseInt(trimmed, 10);
			if (num >= 1 && num <= options.length) return num - 1;
			return "defer";
		} finally {
			rl.close();
		}
	};
}
