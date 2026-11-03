<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import StationModeSwitch from './StationModeSwitch.vue';
defineProps<{ area: 'chat' | 'work' | 'settings' | 'admin' }>();
const auth = useAuthStore();
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const name = computed(() => auth.user?.display_name || auth.user?.login || '');
</script>

<template>
  <div class="station-shell">
    <nav class="station-topbar" :aria-label="en ? 'Main navigation' : '主导航'">
      <div class="rail-brand"><span class="brand-mark" aria-hidden="true">F<span>_</span></span><div><strong>FDE Station</strong><small>INTEVA · WORKSPACE</small></div></div>
      <StationModeSwitch :mode="area" />
      <div class="station-utilities">
        <router-link to="/settings" class="rail-link" :class="{ active: area === 'settings' }" :aria-current="area === 'settings' ? 'page' : undefined"><span class="rail-symbol" aria-hidden="true">⚙</span><span class="full-label">{{ en ? 'Personal settings' : '个人设置' }}</span><span class="compact-label">{{ en ? 'Settings' : '设置' }}</span></router-link>
        <router-link v-if="auth.user?.role === 'admin'" to="/admin" class="rail-link" :class="{ active: area === 'admin' }" :aria-current="area === 'admin' ? 'page' : undefined"><span class="rail-symbol" aria-hidden="true">▦</span><span class="full-label">{{ en ? 'Admin console' : '管理台' }}</span><span class="compact-label">{{ en ? 'Admin' : '管理' }}</span></router-link>
        <div class="rail-profile"><span class="profile-avatar">{{ name.slice(0, 1).toUpperCase() }}</span><div><strong>{{ name }}</strong><small>{{ auth.user?.role === 'admin' ? (en ? 'Administrator' : '管理员') : (en ? 'Workspace member' : '工作空间成员') }}</small></div></div>
      </div>
    </nav>
    <div class="station-surface"><slot /></div>
  </div>
</template>
