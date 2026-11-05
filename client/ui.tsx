// Shared React Native primitives on Paseo's type, spacing, and radius scale. Every color comes
// from the host theme; status colors appear as a 16% tint behind text of the same hue.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ActivityIndicator, Animated, Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { RunStatus } from "../shared/runs";

export interface Navigation {
  openWorkspace(input: { workspaceId: string; serverId?: string }): void;
  openAgent(input: { agentId: string; serverId?: string }): void;
}

export interface Ui {
  theme: PluginTheme;
  compact: boolean;
  /** Client navigation of screens and panels; absent in timeline rows and on older hosts. */
  navigation?: Navigation;
}

const UiContext = createContext<Ui | null>(null);

export function UiProvider({ theme, compact, navigation, children }: Ui & { children: ReactNode }) {
  const value = useMemo(() => ({ theme, compact, navigation }), [theme, compact, navigation]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi outside UiProvider");
  return ui;
}

export type Tone = "default" | "muted" | "accent" | "success" | "warning" | "danger";

export function toneColor(theme: PluginTheme, tone: Tone): string {
  const c = theme.colors;
  return {
    default: c.foreground,
    muted: c.foregroundMuted,
    accent: c.accent,
    success: c.statusSuccess,
    warning: c.statusWarning,
    danger: c.statusDanger,
  }[tone];
}

/** `color` at `alpha` opacity, for tinted backgrounds. Non-hex colors come back unchanged. */
export function tint(color: string, alpha = 0.16): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${full}${a}`;
}

/** Text on a tinted `tone` background: the accent reads poorly as text on dark themes. */
function tintedText(theme: PluginTheme, tone: Tone): string {
  return tone === "accent" ? theme.colors.foreground : toneColor(theme, tone);
}

export function runTone(status: RunStatus, stale = false): Tone {
  if (stale) return "danger";
  return ({ running: "accent", waiting: "warning", done: "success", failed: "danger", cancelled: "muted", interrupted: "warning" } as const)[status];
}

const SIZES = { xs: 11, sm: 12, md: 14, lg: 16, xl: 20, xxl: 26 } as const;
export const MONO = "Menlo, Consolas, monospace";

export function Txt({
  children,
  tone = "default",
  size = "md",
  weight,
  mono,
  numberOfLines,
  selectable,
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  size?: keyof typeof SIZES;
  weight?: "400" | "500" | "600" | "700";
  mono?: boolean;
  numberOfLines?: number;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const { theme } = useUi();
  const fontSize = mono ? SIZES[size] - 1 : SIZES[size];
  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      style={[
        {
          color: toneColor(theme, tone),
          fontSize,
          lineHeight: Math.round(fontSize * (size === "xl" || size === "xxl" ? 1.25 : 1.45)),
          fontWeight: weight,
          fontFamily: mono ? MONO : undefined,
          letterSpacing: size === "xl" || size === "xxl" ? -0.3 : undefined,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Row({
  children,
  gap = 8,
  wrap,
  align = "center",
  justify,
  style,
}: {
  children: ReactNode;
  gap?: number;
  wrap?: boolean;
  align?: ViewStyle["alignItems"];
  justify?: ViewStyle["justifyContent"];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ flexDirection: "row", alignItems: align, justifyContent: justify, gap, flexWrap: wrap ? "wrap" : "nowrap" }, style]}>
      {children}
    </View>
  );
}

export function Stack({ children, gap = 8, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ gap }, style]}>{children}</View>;
}

export function Card({
  children,
  onPress,
  style,
  accessibilityLabel,
  selected,
  padded = true,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  selected?: boolean;
  padded?: boolean;
}) {
  const { theme, compact } = useUi();
  const base: ViewStyle = {
    backgroundColor: theme.colors.surface1,
    borderColor: selected ? theme.colors.accent : theme.colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: padded ? (compact ? 12 : 16) : 0,
    gap: 8,
    overflow: "hidden",
  };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        base,
        (pressed || hovered) && { backgroundColor: theme.colors.surface2 },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

export type ButtonVariant = "primary" | "secondary" | "outline" | "danger" | "ghost";

export function Button({
  label,
  onPress,
  variant = "secondary",
  icon,
  disabled,
  busy,
  small,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: string;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  accessibilityLabel?: string;
}) {
  const { theme } = useUi();
  const c = theme.colors;
  const background = { primary: c.accent, secondary: c.surface2, outline: "transparent", danger: tint(c.statusDanger), ghost: "transparent" }[variant];
  const foreground = { primary: c.accentForeground, secondary: c.foreground, outline: c.foreground, danger: c.statusDanger, ghost: c.foregroundMuted }[variant];
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: small ? 28 : 34,
        paddingHorizontal: small ? 10 : 14,
        borderRadius: 8,
        backgroundColor: (pressed || hovered) && !inactive && (variant === "ghost" || variant === "outline") ? c.surface2 : background,
        borderWidth: variant === "outline" ? 1 : 0,
        borderColor: c.border,
        opacity: inactive ? 0.45 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={foreground} /> : icon ? <Icon name={icon} size={small ? 13 : 15} color={foreground} /> : null}
      <Text numberOfLines={1} style={{ color: foreground, fontSize: small ? 12 : 13, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IconButton({ icon, label, onPress, tone = "muted", disabled }: { icon: string; label: string; onPress: () => void; tone?: Tone; disabled?: boolean }) {
  const { theme } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        width: 30,
        height: 30,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Icon name={icon} size={16} color={toneColor(theme, tone)} />
    </Pressable>
  );
}

export function Badge({ label, tone = "muted", icon }: { label: string; tone?: Tone; icon?: string }) {
  const { theme } = useUi();
  const neutral = tone === "muted" || tone === "default";
  const color = neutral ? theme.colors.foregroundMuted : tintedText(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: neutral ? theme.colors.surface2 : tint(toneColor(theme, tone), tone === "accent" ? 0.45 : 0.16),
        borderRadius: 6,
        paddingHorizontal: 7,
        paddingVertical: 2,
        alignSelf: "flex-start",
      }}
    >
      {icon ? <Icon name={icon} size={11} color={color} /> : null}
      <Text numberOfLines={1} style={{ color, fontSize: 11, fontWeight: "600", lineHeight: 16 }}>
        {label}
      </Text>
    </View>
  );
}

/** A status dot; `pulse` rings it while something runs. */
export function StatusDot({ tone, pulse, size = 8 }: { tone: Tone; pulse?: boolean; size?: number }) {
  const { theme } = useUi();
  const color = toneColor(theme, tone);
  const scale = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(Animated.timing(scale, { toValue: 1, duration: 1400, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [pulse, scale]);
  return (
    <View style={{ width: size * 2, height: size * 2, alignItems: "center", justifyContent: "center" }}>
      {pulse ? (
        <Animated.View
          style={{
            position: "absolute",
            width: size * 2,
            height: size * 2,
            borderRadius: size,
            backgroundColor: color,
            opacity: scale.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
            transform: [{ scale: scale.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.1] }) }],
          }}
        />
      ) : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

export function ProgressBar({ value, tone = "accent", height = 4 }: { value: number; tone?: Tone; height?: number }) {
  const { theme } = useUi();
  const width = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` as const;
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ height, width, borderRadius: height / 2, backgroundColor: toneColor(theme, tone) }} />
    </View>
  );
}

export function Section({ title, description, right, children }: { title: string; description?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <Stack gap={10}>
      <Row justify="space-between" align="flex-end" wrap gap={8}>
        <Stack gap={2} style={{ flexShrink: 1 }}>
          <Txt size="md" weight="600">
            {title}
          </Txt>
          {description ? (
            <Txt size="sm" tone="muted">
              {description}
            </Txt>
          ) : null}
        </Stack>
        {right}
      </Row>
      {children}
    </Stack>
  );
}

export function StatTile({
  icon,
  label,
  value,
  hint,
  tone = "default",
  onPress,
}: {
  icon: string;
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
  onPress?: () => void;
}) {
  const { theme, compact } = useUi();
  return (
    <Card onPress={onPress} accessibilityLabel={`${label}: ${value}`} style={{ flexGrow: 1, flexBasis: compact ? 150 : 200, minWidth: compact ? 150 : 180, gap: 6 }}>
      <Row gap={8}>
        <View style={{ width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: tint(toneColor(theme, tone === "default" ? "accent" : tone), 0.18) }}>
          <Icon name={icon} size={14} color={tone === "default" ? theme.colors.foreground : toneColor(theme, tone)} />
        </View>
        <Txt size="sm" tone="muted">
          {label}
        </Txt>
      </Row>
      <Txt size="xl" weight="600" numberOfLines={1}>
        {value}
      </Txt>
      {hint ? (
        <Txt size="xs" tone="muted" numberOfLines={1}>
          {hint}
        </Txt>
      ) : null}
    </Card>
  );
}

export function Field({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  multiline,
  mono,
  error,
  minHeight,
  autoFocus,
  onSubmit,
}: {
  label?: string;
  hint?: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  error?: string | null;
  minHeight?: number;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  const { theme } = useUi();
  return (
    <Stack gap={6}>
      {label ? (
        <Txt size="sm" weight="500">
          {label}
        </Txt>
      ) : null}
      <TextInput
        accessibilityLabel={label ?? placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline={multiline}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={onSubmit}
        style={{
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface0,
          borderColor: error ? theme.colors.statusDanger : theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: mono ? 12 : 13,
          fontFamily: mono ? MONO : undefined,
          minHeight: multiline ? (minHeight ?? 80) : 34,
          textAlignVertical: multiline ? "top" : "center",
        }}
      />
      {error ? (
        <Txt size="xs" tone="danger">
          {error}
        </Txt>
      ) : hint ? (
        <Txt size="xs" tone="muted">
          {hint}
        </Txt>
      ) : null}
    </Stack>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { label: string; value: T }[];
  value: T | undefined;
  onChange: (value: T) => void;
  label?: string;
}) {
  const { theme } = useUi();
  return (
    <Stack gap={6}>
      {label ? (
        <Txt size="sm" weight="500">
          {label}
        </Txt>
      ) : null}
      <Row gap={4} wrap>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={option.label}
              onPress={() => onChange(option.value)}
              style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
                paddingHorizontal: 10,
                height: 28,
                justifyContent: "center",
                borderRadius: 7,
                backgroundColor: active ? theme.colors.accent : hovered ? theme.colors.surface2 : tint(theme.colors.foregroundMuted, 0.1),
              })}
            >
              <Text numberOfLines={1} style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12, fontWeight: active ? "600" : "500" }}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </Row>
    </Stack>
  );
}

export function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (value: boolean) => void; hint?: string }) {
  const { theme } = useUi();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <View
        style={{
          width: 36,
          height: 20,
          borderRadius: 10,
          padding: 2,
          backgroundColor: value ? theme.colors.accent : theme.colors.surface2,
          borderWidth: 1,
          borderColor: value ? theme.colors.accent : theme.colors.border,
          alignItems: value ? "flex-end" : "flex-start",
        }}
      >
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: value ? theme.colors.accentForeground : theme.colors.foregroundMuted }} />
      </View>
      <Stack gap={0} style={{ flex: 1 }}>
        <Txt size="sm" weight="500">
          {label}
        </Txt>
        {hint ? (
          <Txt size="xs" tone="muted">
            {hint}
          </Txt>
        ) : null}
      </Stack>
    </Pressable>
  );
}

/** A bare on/off switch; `label` is for screen readers. */
export function Switch({ value, onChange, label, disabled, busy }: { value: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; busy?: boolean }) {
  const { theme } = useUi();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: disabled || busy, busy }}
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={() => onChange(!value)}
      hitSlop={6}
      style={{
        width: 38,
        height: 22,
        borderRadius: 11,
        padding: 2,
        justifyContent: "center",
        backgroundColor: value ? theme.colors.accent : theme.colors.surface2,
        borderWidth: 1,
        borderColor: value ? theme.colors.accent : theme.colors.border,
        alignItems: value ? "flex-end" : "flex-start",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={value ? theme.colors.accentForeground : theme.colors.foregroundMuted} style={{ transform: [{ scale: 0.6 }] }} />
      ) : (
        <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? theme.colors.accentForeground : theme.colors.foregroundMuted }} />
      )}
    </Pressable>
  );
}

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { id: T; label: string; icon?: string; badge?: number; badgeTone?: Tone }[];
  value: T;
  onChange: (tab: T) => void;
}) {
  const { theme, compact } = useUi();
  const items = tabs.map((tab) => {
    const active = tab.id === value;
    const color = active ? theme.colors.foreground : theme.colors.foregroundMuted;
    return (
      <Pressable
        key={tab.id}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={tab.badge ? `${tab.label}, ${tab.badge}` : tab.label}
        onPress={() => onChange(tab.id)}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: compact ? 8 : 10,
          paddingTop: 8,
          paddingBottom: 10,
          marginBottom: -1,
          borderBottomWidth: 2,
          borderColor: active ? theme.colors.accent : hovered ? theme.colors.border : "transparent",
        })}
      >
        {tab.icon ? <Icon name={tab.icon} size={15} color={color} /> : null}
        <Text style={{ color, fontSize: 13, fontWeight: active ? "600" : "500" }}>{tab.label}</Text>
        {tab.badge ? (
          <View style={{ backgroundColor: tint(toneColor(theme, tab.badgeTone ?? "accent"), 0.5), borderRadius: 999, minWidth: 18, paddingHorizontal: 5, alignItems: "center" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "700", lineHeight: 16 }}>{tab.badge}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  });
  if (compact) {
    // One scrolling row on phones instead of wrapping onto a second line.
    return (
      <View style={{ borderBottomWidth: 1, borderColor: theme.colors.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 2 }}>
          {items}
        </ScrollView>
      </View>
    );
  }
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, borderBottomWidth: 1, borderColor: theme.colors.border }}>{items}</View>;
}

const NOTICE_ICONS: Record<Tone, string> = {
  default: "Info",
  muted: "Info",
  accent: "Info",
  success: "CircleCheck",
  warning: "TriangleAlert",
  danger: "CircleAlert",
};

export function Notice({ children, tone = "warning", title, action }: { children?: ReactNode; tone?: Tone; title?: string; action?: ReactNode }) {
  const { theme } = useUi();
  const color = tone === "muted" || tone === "default" ? theme.colors.foregroundMuted : toneColor(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 10,
        borderRadius: 10,
        padding: 12,
        backgroundColor: tone === "muted" || tone === "default" ? theme.colors.surface1 : tint(color, 0.1),
        borderWidth: 1,
        borderColor: tone === "muted" || tone === "default" ? theme.colors.border : tint(color, 0.35),
      }}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon name={NOTICE_ICONS[tone]} size={16} color={color} />
      </View>
      <Stack gap={4} style={{ flex: 1 }}>
        {title ? (
          <Txt size="sm" weight="600">
            {title}
          </Txt>
        ) : null}
        {typeof children === "string" ? (
          <Txt size="sm" tone={title ? "muted" : "default"} selectable>
            {children}
          </Txt>
        ) : (
          children
        )}
        {action ? <Row gap={8} wrap>{action}</Row> : null}
      </Stack>
    </View>
  );
}

export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  return (
    <Notice tone="danger" title={title}>
      {errorMessage(error)}
    </Notice>
  );
}

export function Empty({ title, body, action, icon = "Inbox" }: { title: string; body?: string; action?: ReactNode; icon?: string }) {
  const { theme } = useUi();
  return (
    <Stack gap={10} style={{ alignItems: "center", paddingVertical: 36, paddingHorizontal: 16 }}>
      <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
        <Icon name={icon} size={20} color={theme.colors.foregroundMuted} />
      </View>
      <Txt weight="600" style={{ textAlign: "center" }}>
        {title}
      </Txt>
      {body ? (
        <Txt size="sm" tone="muted" style={{ textAlign: "center", maxWidth: 460 }}>
          {body}
        </Txt>
      ) : null}
      {action}
    </Stack>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { theme } = useUi();
  return (
    <Row style={{ paddingVertical: 20 }} justify="center">
      <ActivityIndicator color={theme.colors.foregroundMuted} />
      {label ? (
        <Txt size="sm" tone="muted">
          {label}
        </Txt>
      ) : null}
    </Row>
  );
}

export function Divider() {
  const { theme } = useUi();
  return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
}

export function CodeBlock({ text, maxHeight }: { text: string; maxHeight?: number }) {
  const { theme } = useUi();
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        maxHeight,
        overflow: "hidden",
      }}
    >
      <Txt size="sm" mono selectable>
        {text || " "}
      </Txt>
    </View>
  );
}

export function KeyValue({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  const { compact } = useUi();
  return (
    <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 2 : 12, alignItems: compact ? "flex-start" : "center", minHeight: 22 }}>
      <Txt size="sm" tone="muted" style={{ width: compact ? undefined : 132 }}>
        {label}
      </Txt>
      {typeof value === "string" || typeof value === "number" ? (
        <Txt size="sm" mono={mono} selectable style={{ flex: 1 }}>
          {value}
        </Txt>
      ) : (
        <View style={{ flex: 1 }}>{value}</View>
      )}
    </View>
  );
}

/** The Pi Rust mark: the three blocks of docs/assets/pi-rust-logo.svg on a 4×4 grid. */
export function BrandMark({ size = 28 }: { size?: number }) {
  const cell = size / 4;
  const block = (x: number, y: number, w: number, h: number, color: string) => (
    <View style={{ position: "absolute", left: x * cell, top: y * cell, width: w * cell, height: h * cell, backgroundColor: color }} />
  );
  return (
    <View accessibilityLabel="Pi Rust" style={{ width: size, height: size }}>
      {block(0, 0, 3, 1, "#DE5E28")}
      {block(2, 1, 1, 1, "#DE5E28")}
      {block(0, 1, 1, 3, "#A33B1A")}
      {block(1, 2, 1, 1, "#A33B1A")}
      {block(3, 2, 1, 2, "#E6984F")}
    </View>
  );
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <Txt size="sm">{body}</Txt>
        <Row justify="flex-end">
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label={confirmLabel} variant={danger ? "danger" : "primary"} busy={busy} onPress={onConfirm} />
        </Row>
      </Modal.Content>
    </Modal>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return "";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return seconds <= 5 ? "just now" : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The last two path segments, for narrow rows. */
export function shortPath(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : dir;
}
