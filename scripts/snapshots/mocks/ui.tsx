// @getpaseo/plugin/client/ui for the snapshot app: host components drawn with react-native-web and
// lucide-react. An unknown Lucide name logs an error, as Paseo would reject it.
import * as Lucide from "lucide-react";
import { createElement, type ReactNode } from "react";
import { FlatList as RNFlatList, Pressable, ScrollView as RNScrollView, Text, TextInput as RNTextInput, View } from "react-native";

export const ScrollView = RNScrollView;
export const FlatList = RNFlatList;
export const TextInput = RNTextInput;

const missing = new Set<string>();
export function Icon({ name, icon, size = 16, color = "#888" }: any) {
  const key = name ?? (typeof icon === "string" ? icon : null);
  if (key) {
    const Comp = (Lucide as any)[key];
    if (!Comp || typeof Comp !== "object") {
      if (!missing.has(key)) {
        missing.add(key);
        console.error(`UNKNOWN LUCIDE ICON: ${key}`);
      }
      return <Text style={{ color: "red", fontSize: size }}>?</Text>;
    }
    return createElement(Comp, { size, color, strokeWidth: 2 });
  }
  if (icon && typeof icon === "object" && "svg" in icon) {
    return createElement("img", { src: `data:image/svg+xml;utf8,${encodeURIComponent(icon.svg)}`, width: size, height: size, alt: "" });
  }
  if (typeof icon === "function") return createElement(icon, { size, color });
  return null;
}

export function Modal({ title, open, onOpenChange, children }: { title: string; open: boolean; onOpenChange: (o: boolean) => void; children: ReactNode }) {
  if (!open) return null;
  const t = (window as any).__theme.colors;
  return (
    <View style={{ position: "fixed" as any, inset: 0, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", zIndex: 100 } as any}>
      <View style={{ width: (window as any).__compact ? "100%" : 560, maxHeight: "90%", backgroundColor: t.surface0, borderRadius: 12, borderWidth: 1, borderColor: t.border, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderColor: t.border }}>
          <Text style={{ color: t.foreground, fontSize: 16, fontWeight: "600" }}>{title}</Text>
          <Pressable onPress={() => onOpenChange(false)}>
            <Text style={{ color: t.foregroundMuted }}>✕</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </View>
  );
}
Modal.Content = function Content({ children, contentContainerStyle }: any) {
  return <RNScrollView contentContainerStyle={[{ padding: 24, gap: 16 }, contentContainerStyle]}>{children}</RNScrollView>;
};

export function useToast() {
  return { show: (m: string) => console.log("toast", m), error: (m: string) => console.log("toast error", m) };
}
export function StreamedText({ text, style }: any) {
  return <Text style={style}>{text}</Text>;
}
export function Markdown({ children }: { children: string }) {
  const t = (window as any).__theme.colors;
  return <Text style={{ color: t.foreground, fontSize: 14, lineHeight: 21, whiteSpace: "pre-wrap" } as any}>{children}</Text>;
}
export async function copyText(text: string) {
  console.log("copy", text);
}
function Row({ label, hint, children }: any) {
  const t = (window as any).__theme.colors;
  return (
    <View style={{ padding: 12, gap: 4, borderBottomWidth: 1, borderColor: t.border }}>
      <Text style={{ color: t.foreground }}>{label}</Text>
      {hint ? <Text style={{ color: t.foregroundMuted, fontSize: 12 }}>{hint}</Text> : null}
      {children}
    </View>
  );
}
export const SettingsSection = ({ title, children }: any) => {
  const t = (window as any).__theme.colors;
  return (
    <View style={{ gap: 8, marginBottom: 24 }}>
      <Text style={{ color: t.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{title}</Text>
      {children}
    </View>
  );
};
export const SettingsGroup = SettingsSection;
export const SettingsCard = ({ children }: any) => {
  const t = (window as any).__theme.colors;
  return <View style={{ backgroundColor: t.surface1, borderRadius: 10, borderWidth: 1, borderColor: t.border }}>{children}</View>;
};
export const SettingsRow = Row;
export const SettingsSwitch = (p: any) => <Row {...p}><Text style={{ color: "#7ccba0" }}>{p.value ? "● on" : "○ off"}</Text></Row>;
export const SettingsSelect = (p: any) => <Row {...p}><Text style={{ color: "#7ccba0" }}>{p.options.find((o: any) => o.value === p.value)?.label}</Text></Row>;
export const SettingsInput = (p: any) => <Row {...p}><RNTextInput defaultValue={p.initialValue} placeholder={p.placeholder} style={{ color: "#fff", borderWidth: 1, borderColor: "#444", padding: 6 }} /></Row>;
export const SettingsAction = (p: any) => <Row {...p}><Text style={{ color: "#7ccba0" }}>{p.actionLabel}</Text></Row>;
export const ExternalLink = ({ children }: any) => <Text>{children}</Text>;
export function SidebarRow({ icon, label, active, onPress, trailing }: any) {
  const t = (window as any).__theme.colors;
  return (
    <Pressable onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, height: 32, borderRadius: 6, backgroundColor: active ? t.surface2 : "transparent", width: 240 }}>
      <Icon name={typeof icon === "string" ? icon : undefined} icon={typeof icon === "string" ? undefined : icon} size={16} color={t.foregroundMuted} />
      <Text style={{ color: t.foreground, fontSize: 14, flex: 1 }}>{label}</Text>
      {trailing}
    </Pressable>
  );
}
export const SidebarSeparator = () => <View style={{ height: 1, backgroundColor: "#333" }} />;
export const Loading = () => <Text>Loading…</Text>;
export const DocumentFrame = () => null;
