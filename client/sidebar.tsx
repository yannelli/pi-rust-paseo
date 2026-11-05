// The sidebar row: opens the Pi Rust screen and counts active runs and pending approvals.
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { piRustIcon } from "./brand";
import { SCREEN_ID } from "./host";
import { useRunCounts } from "./manager";
import { tint } from "./ui";

export function SidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const counts = useRunCounts();
  const count = counts.approvals || counts.active;
  const color = counts.approvals ? theme.colors.statusWarning : theme.colors.statusSuccess;
  return (
    <SidebarRow
      icon={{ svg: piRustIcon }}
      label="Pi Rust"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID, params: counts.approvals ? { tab: "runs" } : {} })}
      trailing={
        count ? (
          <View
            accessibilityLabel={counts.approvals ? `${counts.approvals} runs wait for approval` : `${counts.active} active runs`}
            style={{ backgroundColor: tint(color, 0.2), borderRadius: 999, paddingHorizontal: 7, minWidth: 20, alignItems: "center" }}
          >
            <Text style={{ color, fontSize: 11, fontWeight: "700", lineHeight: 18 }}>{count}</Text>
          </View>
        ) : null
      }
    />
  );
}
