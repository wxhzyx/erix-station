<script setup lang="ts">
import { ElIcon } from "element-plus";
import { ChatDotRound, Monitor } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
defineProps<{ mode: "chat" | "work" | "settings" | "admin" }>();
const { locale } = useI18n();
</script>
<template>
  <nav
    class="station-mode-switch mode-navigation"
    :aria-label="locale === 'en' ? 'Station mode' : '工位模式'"
  >
    <router-link
      to="/chat"
      class="mode-navigation-item"
      :class="{ active: mode === 'chat' }"
      :aria-current="mode === 'chat' ? 'page' : undefined"
      ><ElIcon><ChatDotRound /></ElIcon
      ><span class="full-label">{{
        locale === "en" ? "Chat" : "聊天模式"
      }}</span
      ><span class="compact-label">{{
        locale === "en" ? "Chat" : "聊天"
      }}</span></router-link
    >
    <router-link
      to="/"
      class="mode-navigation-item"
      :class="{ active: mode === 'work' }"
      :aria-current="mode === 'work' ? 'page' : undefined"
      ><ElIcon><Monitor /></ElIcon
      ><span class="full-label">{{
        locale === "en" ? "Work" : "工作模式"
      }}</span
      ><span class="compact-label">{{
        locale === "en" ? "Work" : "工作"
      }}</span></router-link
    >
  </nav>
</template>

<style scoped>
.mode-navigation {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mode-navigation-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  color: #75839b;
  font-size: 14px;
  transition: background 0.15s;
}
.mode-navigation-item:hover {
  background: #f1f4fa;
}
.mode-navigation-item.active {
  background: #eaf0ff;
  color: #365cf5;
  font-weight: 650;
}
.mode-navigation-item .el-icon {
  font-size: 20px;
}
.compact-label {
  display: none;
}
@media (max-width: 760px) {
  .mode-navigation {
    flex-direction: row;
  }
  .mode-navigation-item {
    padding: 8px 10px;
  }
  .full-label {
    display: none;
  }
  .compact-label {
    display: inline;
  }
}
</style>
