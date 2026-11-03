<script setup lang="ts">
import { useI18n } from 'vue-i18n';
defineProps<{ mode: 'chat' | 'work' | 'settings' | 'admin' }>();
const { locale } = useI18n();
</script>
<template>
  <nav class="station-mode-switch" :aria-label="locale === 'en' ? 'Station mode' : '工位模式'">
    <router-link to="/chat" class="rail-link" :class="{ active: mode === 'chat' }" :aria-current="mode === 'chat' ? 'page' : undefined"><span class="rail-symbol" aria-hidden="true">◎</span><span>{{ locale === 'en' ? 'Chat' : '聊天模式' }}</span></router-link>
    <router-link to="/" class="rail-link" :class="{ active: mode === 'work' }" :aria-current="mode === 'work' ? 'page' : undefined"><span class="rail-symbol code-symbol" aria-hidden="true">&gt;_</span><span>{{ locale === 'en' ? 'Work' : '工作模式' }}</span></router-link>
  </nav>
</template>
