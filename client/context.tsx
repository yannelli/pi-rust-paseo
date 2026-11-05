// The Context tab: what pi puts in every session's system prompt. SYSTEM.md and APPEND_SYSTEM.md,
// globally and per workspace; the context files (AGENTS.md, CLAUDE.md) pi loads for the workspace;
// and the `@path` includes of the context-include extension.
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { contextRpc, type ContextFile, type ResourceFile } from "../shared/resources";
import { ConfigFiles } from "./extension-detail";
import { FileCard } from "./files";
import { ExtensionGate } from "./gate";
import { useRpcQuery } from "./queries";
import { Badge, ErrorBox, Notice, Row, Section, Spinner, Stack, Txt, shortPath, useUi } from "./ui";
import { WorkspaceNotices } from "./workspaces";

const SYSTEM_TEMPLATE = "You are a coding assistant working in this repository.\n\n";
const APPEND_TEMPLATE = "## House rules\n\n- \n";
const CONTEXT_TEMPLATE = "# Instructions\n\n";

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function ContextTab({ cwd }: { cwd: string }) {
  const data = useRpcQuery(contextRpc, { cwd: cwd || undefined }, { staleTime: 10_000 });
  const value = data.data;
  return (
    <Stack gap={24}>
      {cwd ? <WorkspaceNotices cwd={cwd} what="the workspace's SYSTEM.md and APPEND_SYSTEM.md" /> : null}
      {data.error ? <ErrorBox error={data.error} /> : null}
      {data.isLoading ? <Spinner label="Reading pi's prompt files" /> : null}
      {value ? (
        <>
          <Section
            title="System prompt"
            description="SYSTEM.md replaces pi's built-in prompt, including its tool and safety rules. APPEND_SYSTEM.md adds a section to whichever prompt is in use. A workspace file wins over the global one. New pi sessions read them."
          >
            <Row gap={8} wrap>
              <Txt size="sm" tone="muted">
                In use:
              </Txt>
              <Badge
                icon="FileText"
                tone={value.system.active === "default" ? "muted" : "accent"}
                label={value.system.active === "default" ? "pi's built-in prompt" : value.system.active === "project" ? "workspace SYSTEM.md" : "global SYSTEM.md"}
              />
              <Txt size="sm" tone="muted">
                +
              </Txt>
              <Badge icon="ListPlus" tone={value.append.active === "none" ? "muted" : "accent"} label={value.append.active === "none" ? "no addendum" : value.append.active === "project" ? "workspace APPEND_SYSTEM.md" : "global APPEND_SYSTEM.md"} />
            </Row>
            <PromptPair
              cwd={cwd}
              name="SYSTEM.md"
              global={value.system.global}
              project={value.system.project}
              active={value.system.active}
              template={SYSTEM_TEMPLATE}
              note="Replaces pi's built-in prompt. Without tool rules, models may use tools poorly; APPEND_SYSTEM.md is usually what you want."
            />
            <PromptPair cwd={cwd} name="APPEND_SYSTEM.md" global={value.append.global} project={value.append.project} active={value.append.active} template={APPEND_TEMPLATE} />
          </Section>
          <Section
            title="Context files"
            description="pi adds these to every session here, in this order: the file in pi's agent directory, then one per directory from / down to the workspace. In each directory the first of AGENTS.override.md, AGENTS.md, and CLAUDE.md counts."
          >
            {value.contextFiles.length === 0 ? (
              <Txt size="sm" tone="muted">
                No context files here.
              </Txt>
            ) : null}
            {value.contextFiles.map((file, index) => (
              <ContextFileCard key={file.path} file={file} index={index} cwd={cwd} />
            ))}
            {value.missing.map((file) => (
              <FileCard
                key={file.path}
                cwd={cwd}
                file={file}
                title={file.origin === "agent" ? "Global AGENTS.md" : "This workspace's AGENTS.md"}
                description={file.origin === "agent" ? "Every pi session reads it, in every directory." : "Sessions in this workspace and below read it. Commit it to share it."}
                template={CONTEXT_TEMPLATE}
                createLabel="Create"
              />
            ))}
          </Section>
          <Section title="Includes" description="With the context-include extension on, a line that is only @path/to/file.md in a context file pulls that file into the prompt. Paths are relative to the context file; ~ is your home directory.">
            <ExtensionGate name="context-include">Context files keep their @path lines as plain text until it is on.</ExtensionGate>
            <ConfigFiles name="context-include" cwd={cwd} />
          </Section>
        </>
      ) : null}
    </Stack>
  );
}

function PromptPair({
  cwd,
  name,
  global,
  project,
  active,
  template,
  note,
}: {
  cwd: string;
  name: string;
  global: ResourceFile;
  project: ResourceFile | null;
  active: string;
  template: string;
  note?: string;
}) {
  const inUse = <Badge label="in use" tone="success" icon="Check" />;
  const shadowed = <Badge label="overridden" tone="warning" />;
  return (
    <Stack gap={10}>
      <FileCard
        cwd={cwd}
        file={global}
        title={`Global ${name}`}
        description={global.exists ? undefined : note}
        template={template}
        badges={global.exists ? (active === "global" ? inUse : active === "project" ? shadowed : null) : null}
      />
      {project ? (
        <FileCard
          cwd={cwd}
          file={project}
          title={`Workspace ${name}`}
          description={project.exists ? undefined : `In ${shortPath(project.path.replace(/\/[^/]+$/, ""))}. Wins over the global file in this workspace.`}
          template={template}
          badges={project.exists && active === "project" ? inUse : null}
        />
      ) : null}
    </Stack>
  );
}

function ContextFileCard({ file, index, cwd }: { file: ContextFile; index: number; cwd: string }) {
  const { theme } = useUi();
  const label = file.origin === "agent" ? "pi agent directory" : file.origin === "workspace" ? "This workspace" : shortPath(file.path.replace(/\/[^/]+$/, "") || "/");
  return (
    <FileCard
      cwd={cwd}
      file={file}
      title={`${index + 1}. ${label}`}
      badges={
        <>
          <Badge label={file.path.split("/").pop() ?? ""} />
          <Badge label={kb(file.bytes)} />
        </>
      }
    >
      {file.includes.length ? (
        <Stack gap={4}>
          {file.includes.map((include) => (
            <Row key={`${include.line}:${include.ref}`} gap={8}>
              <Icon name={include.exists ? "CornerDownRight" : "CircleAlert"} size={13} color={include.exists ? theme.colors.foregroundMuted : theme.colors.statusWarning} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt size="xs" mono numberOfLines={1} tone={include.exists ? "muted" : "warning"}>
                  {`@${include.ref}${include.exists ? "" : " (missing)"}`}
                </Txt>
              </View>
              <Txt size="xs" tone="muted">{`line ${include.line}`}</Txt>
            </Row>
          ))}
        </Stack>
      ) : null}
      {file.origin === "parent" ? <Notice tone="muted">This file is above the workspace, so other projects under the same directory read it too.</Notice> : null}
    </FileCard>
  );
}
