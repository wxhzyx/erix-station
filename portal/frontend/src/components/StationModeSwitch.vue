<script setup lang="ts">
import { useI18n } from 'vue-i18n';
defineProps<{ mode: 'chat' | 'work' }>();
const { locale } = useI18n();
</script>
<template>
  <nav class="station-mode-switch flex shrink-0 p-1 text-sm" :aria-label="locale === 'en' ? 'Station mode' : '工位模式'">
    <router-link to="/chat" class="rounded-lg px-3 py-1.5" :class="mode === 'chat' ? 'mode-active' : 'mode-inactive'" :aria-current="mode === 'chat' ? 'page' : undefined">{{ locale === 'en' ? 'Chat' : '聊天模式' }}</router-link>
    <router-link to="/" class="rounded-lg px-3 py-1.5" :class="mode === 'work' ? 'mode-active' : 'mode-inactive'" :aria-current="mode === 'work' ? 'page' : undefined">{{ locale === 'en' ? 'Work' : '工作模式' }}</router-link>
  </nav>
</template>
