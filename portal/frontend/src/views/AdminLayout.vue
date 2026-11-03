<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import StationShell from '../components/StationShell.vue';
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const en = computed(() => locale.value === 'en');
const groups = computed(() => [
  { label: en.value ? 'DELIVERY' : '项目与交付', items: [
    { path: '/admin/delivery', label: en.value ? 'Project delivery' : '项目交付', hint: en.value ? 'Packages and assignments' : '交付包与项目下发' },
    { path: '/admin/approvals', label: en.value ? 'Project reviews' : '项目审批', hint: en.value ? 'Review and merge changes' : '审查与合并项目变更' },
  ] },
  { label: en.value ? 'ACCESS & USAGE' : '成员与资源', items: [
    { path: '/admin/users', label: en.value ? 'Members & workstations' : '成员与工位', hint: en.value ? 'Accounts, access and lifecycle' : '账号权限与工位管理' },
    { path: '/admin/quotas', label: en.value ? 'Token quotas' : '额度与申请', hint: en.value ? 'Daily limits and upgrade requests' : '每日额度与升级审批' },
  ] },
  { label: en.value ? 'PLATFORM' : '平台配置', items: [
    { path: '/admin/llm', label: en.value ? 'API & models' : 'API 与模型', hint: en.value ? 'Providers, credentials and models' : '统一管理 API 接入与模型目录' },
    { path: '/admin/model-access', label: en.value ? 'Model assignments' : '用户模型分配', hint: en.value ? 'Assign chat and work models' : '为成员配置聊天与开发模型' },
    { path: '/admin/repos', label: en.value ? 'Repositories' : '仓库接入', hint: en.value ? 'Repository connections' : '代码仓库连接与配置' },
    { path: '/admin/preview-pool', label: en.value ? 'Preview resources' : '预览资源', hint: en.value ? 'Preview port allocation' : '预览端口分配与占用' },
  ] },
]);
const current = computed(() => groups.value.flatMap(g => g.items).find(i => i.path === route.path));
async function onLogout() { await auth.logout(); await router.replace('/login'); }
</script>
<template>
  <StationShell area="admin">
    <div class="station-admin console-page">
      <header class="station-header"><div><span class="page-eyebrow">ORGANIZATION / ADMIN</span><h1>{{ t('admin.title') }}</h1></div><div class="header-actions"><span class="status-pill">{{ en ? 'Administrator' : '管理员' }}</span><button class="station-secondary" @click="onLogout">{{ t('common.logout') }}</button></div></header>
      <div class="admin-layout">
        <nav class="admin-navigation" :aria-label="t('admin.tabs.label')"><div v-for="group in groups" :key="group.label" class="admin-nav-group"><h2>{{ group.label }}</h2><router-link v-for="item in group.items" :key="item.path" :to="item.path" :class="{ active: route.path === item.path }" :aria-current="route.path === item.path ? 'page' : undefined">{{ item.label }}</router-link></div></nav>
        <main class="console-content admin-content"><div v-if="current" class="page-intro"><h2>{{ current.label }}</h2><p>{{ current.hint }}</p></div><router-view :key="route.path" /></main>
      </div>
    </div>
  </StationShell>
</template>
