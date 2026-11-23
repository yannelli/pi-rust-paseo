// The dialog an extension command waits on: a select, a confirm, an input, or an editor, answered
// from Paseo. A dialog with a timeout counts down and gives up when pi does.
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import type { CommandAnswer, CommandDialog } from "../shared/contracts";
import { Button, Field, Row, Stack, Txt, UiModal, useUi } from "./ui";

/** Seconds until `timeoutMs` from when the dialog appeared ends; null without a timeout. */
function useSecondsLeft(dialog: CommandDialog | null): number | null {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setDeadline(dialog?.timeoutMs != null ? Date.now() + dialog.timeoutMs : null);
    setNow(Date.now());
  }, [dialog?.id]);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function CommandDialogModal({
  command,
  dialog,
  busy,
  onAnswer,
}: {
  command: string;
  dialog: CommandDialog | null;
  busy: boolean;
  onAnswer: (dialog: string, answer: CommandAnswer) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => setText(dialog?.prefill ?? ""), [dialog?.id]);
  const secondsLeft = useSecondsLeft(dialog);
  const expired = secondsLeft === 0;
  // pi goes on without an answer once the timeout ends; the server then drops this answer and
  // returns what comes next.
  useEffect(() => {
    if (dialog && expired && !busy) onAnswer(dialog.id, { cancelled: true });
  }, [dialog?.id, expired]);
  const answer = (value: CommandAnswer) => {
    if (dialog && !busy) onAnswer(dialog.id, value);
  };
  const cancel = () => answer({ cancelled: true });
  return (
    <UiModal title={`/${command}`} open={Boolean(dialog)} onClose={cancel}>
      {dialog ? (
        <Stack gap={14}>
          {dialog.title ? (
            <Txt size="md" weight="600" selectable>
              {dialog.title}
            </Txt>
          ) : null}
          {dialog.message ? (
            <Txt size="sm" tone="muted" selectable>
              {dialog.message}
            </Txt>
          ) : null}
          {dialog.method === "select" ? <Options options={dialog.options} disabled={busy} onPick={(value) => answer({ value })} /> : null}
          {dialog.method === "input" ? (
            <Field value={text} onChangeText={setText} placeholder={dialog.placeholder ?? undefined} secret={dialog.secret} autoFocus onSubmit={() => answer({ value: text })} />
          ) : null}
          {dialog.method === "editor" ? <Field value={text} onChangeText={setText} placeholder={dialog.placeholder ?? undefined} multiline minHeight={180} autoFocus /> : null}
          {secondsLeft !== null ? (
            <Txt size="xs" tone="muted">
              {expired ? "pi stopped waiting for an answer." : `pi stops waiting in ${secondsLeft} s.`}
            </Txt>
          ) : null}
          <Row justify="flex-end" gap={8} wrap>
            <Button label="Cancel" variant="ghost" disabled={busy} onPress={cancel} />
            {dialog.method === "confirm" ? (
              <>
                <Button label="No" variant="outline" disabled={busy} onPress={() => answer({ confirmed: false })} />
                <Button label="Yes" variant="primary" busy={busy} onPress={() => answer({ confirmed: true })} />
              </>
            ) : null}
            {dialog.method === "input" || dialog.method === "editor" ? <Button label="Submit" variant="primary" busy={busy} onPress={() => answer({ value: text })} /> : null}
          </Row>
        </Stack>
      ) : null}
    </UiModal>
  );
}

function Options({ options, disabled, onPick }: { options: string[]; disabled: boolean; onPick: (value: string) => void }) {
  const { theme } = useUi();
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" }}>
      {options.map((option, index) => (
        <Pressable
          key={`${index}:${option}`}
          accessibilityRole="button"
          accessibilityLabel={option}
          disabled={disabled}
          onPress={() => onPick(option)}
          style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            minHeight: 44,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderTopWidth: index === 0 ? 0 : 1,
            borderColor: theme.colors.border,
            backgroundColor: hovered && !disabled ? theme.colors.surface2 : theme.colors.surface1,
            opacity: disabled ? 0.6 : 1,
          })}
        >
          <Txt size="sm" style={{ flex: 1 }}>
            {option}
          </Txt>
          <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ))}
    </View>
  );
}
