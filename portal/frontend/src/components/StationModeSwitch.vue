<script setup lang="ts">
import { ElIcon } from 'element-plus';
import { ChatDotRound, Monitor } from '@element-plus/icons-vue';
import { useI18n } from 'vue-i18n';
defineProps<{ mode: 'chat' | 'work' | 'settings' | 'admin' }>();
const { locale } = useI18n();
</script>
<template>
  <nav class="station-mode-switch" :aria-label="locale === 'en' ? 'Station mode' : '工位模式'">
    <router-link to="/chat" class="rail-link" :class="{ active: mode === 'chat' }" :aria-current="mode === 'chat' ? 'page' : undefined"><ElIcon><ChatDotRound /></ElIcon><span class="full-label">{{ locale === 'en' ? 'Chat' : '聊天模式' }}</span><span class="compact-label">{{ locale === 'en' ? 'Chat' : '聊天' }}</span></router-link>
    <router-link to="/" class="rail-link" :class="{ active: mode === 'work' }" :aria-current="mode === 'work' ? 'page' : undefined"><ElIcon><Monitor /></ElIcon><span class="full-label">{{ locale === 'en' ? 'Work' : '工作模式' }}</span><span class="compact-label">{{ locale === 'en' ? 'Work' : '工作' }}</span></router-link>
  </nav>
</template>
