<script setup lang="ts">
import { ElMenu, ElMenuItem } from 'element-plus';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import StationShell from '../components/StationShell.vue';
const { t, locale } = useI18n();
const route = useRoute();
const en = computed(() => locale.value === 'en');
const groups = computed(() => [
  { label: en.value ? 'DELIVERY' : '项目与交付', items: [
    { path: '/admin/delivery', label: en.value ? 'Project delivery' : '项目交付' },
    { path: '/admin/projects', label: en.value ? 'Shared projects' : '共享项目' },
    { path: '/admin/approvals', label: en.value ? 'Project reviews' : '项目审批' },
  ] },
  { label: en.value ? 'ACCESS & USAGE' : '成员与资源', items: [
    { path: '/admin/users', label: en.value ? 'Members & workstations' : '成员与工位' },
    { path: '/admin/quotas', label: en.value ? 'Token quotas' : '额度与申请' },
  ] },
  { label: en.value ? 'PLATFORM' : '平台配置', items: [
    { path: '/admin/llm', label: en.value ? 'API & models' : 'API 与模型' },
    { path: '/admin/model-access', label: en.value ? 'Model assignments' : '用户模型分配' },
    { path: '/admin/repos', label: en.value ? 'Repositories' : '仓库接入' },
    { path: '/admin/preview-pool', label: en.value ? 'Running ports' : '运行端口' },
  ] },
]);
const current = computed(() => groups.value.flatMap(g => g.items).find(i => i.path === route.path));
</script>
<template>
  <StationShell area="admin">
    <div class="station-admin console-page">
      <div class="admin-layout">
        <nav class="admin-navigation" :aria-label="t('admin.tabs.label')">
          <ElMenu mode="horizontal" :default-active="route.path" :ellipsis="false">
            <ElMenuItem v-for="item in groups.flatMap(group => group.items)" :key="item.path" :index="item.path">
              <router-link :to="item.path" :aria-current="route.path === item.path ? 'page' : undefined">{{ item.label }}</router-link>
            </ElMenuItem>
          </ElMenu>
        </nav>
        <main class="console-content admin-content"><div v-if="current" class="page-intro"><h1>{{ current.label }}</h1></div><router-view :key="route.path" /></main>
      </div>
    </div>
  </StationShell>
</template>
