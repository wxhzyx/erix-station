<script setup lang="ts">
import {
  ElAvatar,
  ElIcon,
  ElDropdown,
  ElDropdownMenu,
  ElDropdownItem,
  ElMenu,
  ElMenuItem,
} from "element-plus";
import {
  ChatDotRound,
  Monitor,
  FolderOpened,
  Lock,
  ArrowDown,
} from "@element-plus/icons-vue";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../stores/auth";
import QuotaIndicator from "./QuotaIndicator.vue";
defineProps<{ area: "chat" | "work" | "settings" | "admin" }>();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { locale } = useI18n();
const en = computed(() => locale.value === "en");
const name = computed(() => auth.user?.display_name || auth.user?.login || "");
const selected = computed(() =>
  route.path.startsWith("/admin")
    ? "/admin"
    : route.path.startsWith("/chat")
      ? "/chat"
      : route.path.startsWith("/projects")
        ? "/projects"
        : ["/settings", "/mode-settings"].includes(route.path)
          ? "/settings"
          : "/",
);
async function accountAction(command: string) {
  if (command === "logout") {
    await auth.logout();
    await router.replace("/login");
  } else
    await router.push(
      command === "usage" ? "/settings?tab=usage" : "/settings",
    );
}
</script>
<template>
  <div class="station-shell">
    <nav class="station-topbar" :aria-label="en ? 'Main navigation' : '主导航'">
      <router-link to="/" class="rail-brand" aria-label="FDE Station"
        ><span class="brand-mark">F<span>·</span></span
        ><span class="brand-caption"
          ><strong>FDE Station</strong></span
        ></router-link
      >
      <ElMenu class="rail-menu" mode="horizontal" :ellipsis="false" :default-active="selected" router>
        <ElMenuItem
          index="/chat"
          :aria-label="en ? 'Chat' : '聊天'"
          :title="en ? 'Chat' : '聊天'"
          ><ElIcon><ChatDotRound /></ElIcon
          ><span>{{ en ? "Chat" : "聊天" }}</span></ElMenuItem
        >
        <ElMenuItem
          index="/"
          :aria-label="en ? 'Workbench' : '开发工作台'"
          :title="en ? 'Workbench' : '开发工作台'"
          ><ElIcon><Monitor /></ElIcon
          ><span>{{ en ? "Workbench" : "开发工作台" }}</span></ElMenuItem
        >
        <ElMenuItem
          index="/projects"
          :aria-label="en ? 'Projects' : '项目协作'"
          :title="en ? 'Projects' : '项目协作'"
          ><ElIcon><FolderOpened /></ElIcon
          ><span>{{ en ? "Projects" : "项目协作" }}</span></ElMenuItem
        >
        <ElMenuItem
          v-if="auth.user?.role === 'admin'"
          index="/admin"
          :aria-label="en ? 'Admin console' : '管理台'"
          :title="en ? 'Admin console' : '管理台'"
          ><ElIcon><Lock /></ElIcon
          ><span>{{ en ? "Admin console" : "管理台" }}</span></ElMenuItem
        >
      </ElMenu>
      <div class="rail-bottom">
        <div
          v-if="auth.user && (area === 'work' || area === 'chat')"
          class="rail-quota"
        >
          <QuotaIndicator />
        </div>
        <ElDropdown
          trigger="click"
          placement="bottom-end"
          @command="accountAction"
        >
          <button
            type="button"
            class="account-trigger"
            :aria-label="en ? 'Account menu' : '账号菜单'"
          >
            <ElAvatar :size="34">{{ name.slice(0, 1).toUpperCase() }}</ElAvatar
            ><span class="account-name"
              ><strong>{{ name }}</strong
              ></span
            ><ElIcon><ArrowDown /></ElIcon>
          </button>
          <template #dropdown
            ><ElDropdownMenu
              ><ElDropdownItem command="settings">{{
                en ? "Personal settings" : "个人设置"
              }}</ElDropdownItem
              ><ElDropdownItem command="usage">{{
                en ? "Usage & quota" : "用量与额度"
              }}</ElDropdownItem
              ><ElDropdownItem
                command="logout"
                divided
                data-testid="account-logout"
                >{{ en ? "Sign out" : "退出登录" }}</ElDropdownItem
              ></ElDropdownMenu
            ></template
          >
        </ElDropdown>
      </div>
    </nav>
    <div class="station-surface"><slot /></div>
  </div>
</template>
