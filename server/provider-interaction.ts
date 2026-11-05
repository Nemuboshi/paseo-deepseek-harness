import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import type { InteractionRequest, QuestionAnswer, QuestionItem } from "../shared/bridge-protocol.js";
import { objectValue } from "./values.js";

export function permissionRequest(interaction: InteractionRequest): ProviderPermissionRequest {
  if (interaction.kind === "questions") {
    return {
      id: interaction.requestId,
      name: "question",
      kind: "question" as const,
      title: "DeepSeek Harness question",
      input: {
        questions: (interaction.questions ?? []).map((question) => ({
          question: question.question,
          header: question.header ?? question.id,
          options: question.options ?? [],
          multiSelect: question.multiSelect ?? false,
          allowOther: true,
        })),
      },
    };
  }
  return {
    id: interaction.requestId,
    name: interaction.toolName ?? "tool",
    kind: "tool" as const,
    title: interaction.toolName ? `Allow ${interaction.toolName}?` : "Allow tool?",
    description: interaction.reason,
    input: { callId: interaction.callId ?? "" },
    actions: [
      { id: "allow-once", label: "Allow once", behavior: "allow" as const, variant: "primary" as const },
      { id: "reject", label: "Reject", behavior: "deny" as const, variant: "secondary" as const },
    ],
  };
}

export function questionAnswers(
  questions: QuestionItem[],
  response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
): QuestionAnswer[] {
  const answers = objectValue(response.updatedInput?.answers);
  return questions.map((question) => {
    const key = question.header ?? question.id;
    const raw = answers?.[key];
    if (typeof raw !== "string" || raw.length === 0) return { id: question.id, selected: [] };
    const labels = (question.options ?? []).map((option) => option.label);
    if (!question.multiSelect) {
      return labels.includes(raw)
        ? { id: question.id, selected: [raw] }
        : { id: question.id, selected: [], custom: raw };
    }
    // Paseo joins checked labels and the optional typed answer with ", ".
    // Match complete labels (longest first), keeping the remaining text intact.
    const candidates = labels.filter(Boolean).sort((left, right) => right.length - left.length);
    const selected: string[] = [];
    let custom = raw;
    while (custom.length > 0) {
      const label = candidates.find((value) =>
        !selected.includes(value) && (custom === value || custom.startsWith(`${value}, `)));
      if (label === undefined) break;
      selected.push(label);
      custom = custom === label ? "" : custom.slice(label.length + 2);
    }
    return {
      id: question.id,
      selected,
      ...(custom ? { custom } : {}),
    };
  });
}
