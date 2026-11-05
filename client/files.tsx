// A text file pi reads (a system prompt, a context file, a skill, a prompt template) as a card that
// opens into an editor. The server checks that the path is one pi reads before it writes.
import { useEffect, useState, type ReactNode } from "react";
import { fileDeleteRpc, fileWriteRpc, type ResourceFile } from "../shared/resources";
import { useRpcMutation } from "./queries";
import { Badge, Button, Card, ConfirmModal, ErrorBox, Field, Notice, Row, Stack, Txt, shortPath } from "./ui";

/** Queries that list files, refetched after a save or a delete. */
export const FILE_QUERIES = ["res.context", "res.skills", "res.prompts", "res.read", "claude.state"] as const;

export function FileCard({
  title,
  file,
  cwd,
  badges,
  description,
  placeholder,
  template,
  createLabel = "Create",
  deletable = true,
  open: initiallyOpen = false,
  minHeight = 220,
  children,
}: {
  title: string;
  file: ResourceFile;
  cwd: string;
  badges?: ReactNode;
  description?: string;
  placeholder?: string;
  /** The text a new file starts with. */
  template?: string;
  createLabel?: string;
  deletable?: boolean;
  open?: boolean;
  minHeight?: number;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [text, setText] = useState(file.exists ? file.text : (template ?? ""));
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setText(file.exists ? file.text : (template ?? "")), [file.text, file.exists, template]);
  const write = useRpcMutation(fileWriteRpc, { invalidates: FILE_QUERIES, success: (result) => `Saved ${shortPath(result.path)}` });
  const remove = useRpcMutation(fileDeleteRpc, {
    invalidates: FILE_QUERIES,
    success: (result) => `Deleted ${shortPath(result.path)}`,
    onSuccess: () => {
      setConfirm(false);
      setOpen(false);
    },
  });
  const changed = file.exists ? text !== file.text : text.trim().length > 0;
  return (
    <Card style={{ gap: 10 }}>
      <Row justify="space-between" gap={8} align="flex-start">
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Row gap={6} wrap>
            <Txt size="sm" weight="600">
              {title}
            </Txt>
            {file.exists ? null : <Badge label="no file" />}
            {badges}
          </Row>
          <Txt size="xs" tone="muted" mono numberOfLines={1}>
            {shortPath(file.path)}
          </Txt>
          {description ? (
            <Txt size="xs" tone="muted">
              {description}
            </Txt>
          ) : null}
        </Stack>
        {file.editable || file.exists ? (
          <Button small variant="outline" label={open ? "Close" : file.exists ? (file.editable ? "Edit" : "View") : createLabel} onPress={() => setOpen(!open)} />
        ) : null}
      </Row>
      {children}
      {!file.editable && file.reason ? <Notice tone="muted">{file.reason}</Notice> : null}
      {open ? (
        <Stack gap={8}>
          <Field value={text} onChangeText={file.editable ? setText : () => undefined} multiline mono minHeight={minHeight} placeholder={placeholder} />
          {write.error ? <ErrorBox error={write.error} /> : null}
          {file.editable ? (
            <Row justify="space-between" gap={8} wrap>
              {deletable && file.exists ? <Button small variant="ghost" icon="Trash2" label="Delete" onPress={() => setConfirm(true)} /> : <Txt size="xs" tone="muted"> </Txt>}
              <Row gap={8}>
                <Button label="Revert" variant="ghost" disabled={!changed} onPress={() => setText(file.exists ? file.text : (template ?? ""))} />
                <Button label={file.exists ? "Save" : createLabel} variant="primary" disabled={!changed} busy={write.isPending} onPress={() => write.mutate({ cwd: cwd || undefined, path: file.path, text })} />
              </Row>
            </Row>
          ) : null}
        </Stack>
      ) : null}
      <ConfirmModal
        open={confirm}
        title={`Delete ${title}?`}
        body={`This deletes ${file.path}. pi stops reading it in new sessions.`}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate({ cwd: cwd || undefined, path: file.path })}
        onClose={() => setConfirm(false)}
      />
    </Card>
  );
}
